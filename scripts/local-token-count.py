"""Metadata-only GGUF token counting; measured text is not a measured CLI envelope.
Never imports a model, loads tensor weights, downloads files, or performs inference.
Unsupported tokenizer/template/normalization combinations fail closed.
"""
import hashlib
import importlib.metadata
import io
import json
import re
import struct
import sys
import unicodedata
from pathlib import Path

MAX_METADATA = 32 * 1024 * 1024
# Exact Ollama Go template whose single user-message rendering is supported below.
CHATML_TEMPLATE = "1e65450c30670713aa47fe23e8b9662bdf4065e81cc8e3cbfaa98924fcc0d320"
QWEN35_TEMPLATE = "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715"
# llama.cpp src/llama-vocab.cpp LLAMA_VOCAB_PRE_TYPE_QWEN35, matching the
# official Qwen3.5 tokenizer: combining marks belong to letters, unlike Qwen2.
QWEN35_PATTERN = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+"

def image_reserves(paths):
    if not isinstance(paths, list) or len(paths) > 6:
        raise ValueError("At most six images can be reserved")
    result = []
    for name in paths:
        path = Path(name)
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 8000000:
            raise ValueError("Image must be a bounded regular file")
        data = path.read_bytes()
        if len(data) > 8000000:
            raise ValueError("Image changed beyond bound")
        from PIL import Image
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            if image.format not in {"PNG", "JPEG", "WEBP"} or getattr(image, "n_frames", 1) != 1 or min(width, height) < 1 or max(width, height) > 16384 or width * height > 16777216:
                raise ValueError("Image dimensions or format exceed verified vision reserve profile")
            image.verify()
        # Qwen3.5 official preprocessor: 16px patches, merge2, minimum65536px.
        # Reserve UNMERGED patches (4x merged tokens), round both axes upward,
        # and a 1024-token floor for runtime resizing. This is an upper reserve,
        # not a claim to measure the server's image embedding token count.
        reserve = max(1024, ((width + 31) // 32) * ((height + 31) // 32) * 4) + 64
        result.append({"sha256":sha(data), "bytes":len(data), "width":width, "height":height, "reservedTokens":reserve})
    return result

def sha(data):
    return hashlib.sha256(data).hexdigest()

class GGUFMetadata:
    def __init__(self, path):
        self.file = path.open("rb")
    def take(self, count):
        if count < 0 or self.file.tell() + count > MAX_METADATA:
            raise ValueError("GGUF metadata exceeds bound")
        data = self.file.read(count)
        if len(data) != count:
            raise ValueError("Truncated GGUF metadata")
        return data
    def scalar(self, fmt):
        return struct.unpack("<" + fmt, self.take(struct.calcsize("<" + fmt)))[0]
    def string(self):
        return self.take(self.scalar("Q")).decode("utf8")
    def value(self, kind, depth=0):
        if depth > 1:
            raise ValueError("Nested GGUF metadata arrays unsupported")
        if kind == 8:
            return self.string()
        if kind == 9:
            subtype, count = self.scalar("I"), self.scalar("Q")
            if count > 1000000:
                raise ValueError("GGUF metadata array exceeds bound")
            return [self.value(subtype, depth + 1) for _ in range(count)]
        formats = {0:"B",1:"b",2:"H",3:"h",4:"I",5:"i",6:"f",7:"?",10:"Q",11:"q",12:"d"}
        if kind not in formats:
            raise ValueError("Unknown GGUF metadata type")
        return self.scalar(formats[kind])
    def read(self):
        try:
            if self.take(4) != b"GGUF" or self.scalar("I") != 3:
                raise ValueError("Only GGUF v3 metadata supported")
            self.scalar("Q")  # tensor count; no tensor information/data is read
            count = self.scalar("Q")
            if count > 10000:
                raise ValueError("GGUF metadata count exceeds bound")
            result = {}
            for _ in range(count):
                key = self.string()
                if key in result:
                    raise ValueError("Duplicate GGUF metadata key")
                result[key] = self.value(self.scalar("I"))
            end = self.file.tell()
            self.file.seek(0)
            return result, sha(self.take(end)), end
        finally:
            self.file.close()

def blob(root, layer, limit=None):
    digest = layer["digest"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("Invalid model layer digest")
    path = root / "blobs" / digest.replace(":", "-")
    if path.stat().st_size != layer["size"]:
        raise ValueError("Installed model layer size changed")
    if limit is not None:
        if layer["size"] > limit:
            raise ValueError("Model envelope exceeds bound")
        data = path.read_bytes()
        if sha(data) != digest.split(":")[1]:
            raise ValueError("Model envelope digest changed")
        return data
    return path

def verified_versions():
    versions = {name: importlib.metadata.version(name) for name in ("tokenizers", "transformers")}
    if versions != {"tokenizers": "0.22.2", "transformers": "5.15.0"}:
        raise ValueError("Tokenizer/converter versions differ from the verified offline profile")
    return versions

def count(request):
    versions = verified_versions()
    if set(request) not in ({"manifest", "modelRoot", "digest", "prompt"}, {"manifest", "modelRoot", "digest", "prompt", "images"}):
        raise ValueError("Exact tokenizer request fields required")
    prompt = request["prompt"]
    if not isinstance(prompt, str) or len(prompt.encode()) > 131072:
        raise ValueError("Prompt exceeds bounded tokenizer packet")
    root = Path(request["modelRoot"]).resolve()
    manifest_path = Path(request["manifest"]).resolve()
    if not manifest_path.is_relative_to(root / "manifests"):
        raise ValueError("Manifest escapes installed model store")
    if manifest_path.stat().st_size > 65536:
        raise ValueError("Model manifest exceeds bound")
    raw = manifest_path.read_bytes()
    if sha(raw) != request["digest"]:
        raise ValueError("Installed manifest differs from measured runtime digest")
    manifest = json.loads(raw)
    layers = manifest["layers"]
    def only(suffix, optional=False):
        matches = [x for x in layers if x["mediaType"] == "application/vnd.ollama.image." + suffix]
        if optional and not matches:
            return None
        if len(matches) != 1:
            raise ValueError("Unsupported installed model layer layout")
        return matches[0]
    template_layer = only("template", True)
    template = blob(root, template_layer, 65536) if template_layer else None
    system_layer = only("system", True)
    system = blob(root, system_layer, 65536).decode() if system_layer else ""
    if not unicodedata.is_normalized("NFC", prompt + system):
        raise ValueError("Non-NFC text needs native tokenizer verification")
    # Adapters, history, tools and template overrides are outside this route.
    supported_layers = {"model", "system", "template", "license", "params"}
    if any(x["mediaType"].removeprefix("application/vnd.ollama.image.") not in supported_layers for x in layers):
        raise ValueError("Unsupported installed model layers")
    params_layer = only("params", True)
    if params_layer:
        params = json.loads(blob(root, params_layer, 65536))
        if any(k not in {"num_ctx", "temperature", "top_k", "top_p", "repeat_penalty", "presence_penalty", "frequency_penalty", "stop", "num_predict"} for k in params):
            raise ValueError("Unverified model parameters may affect the prompt")
    model_layer = only("model")
    metadata, metadata_hash, metadata_bytes = GGUFMetadata(blob(root, model_layer)).read()
    profile = metadata.get("tokenizer.ggml.pre")
    if metadata.get("tokenizer.ggml.model") != "gpt2" or profile not in {"qwen2", "qwen35"} or metadata.get("tokenizer.ggml.add_bos_token", profile != "qwen35") or metadata.get("tokenizer.ggml.add_eos_token", False):
        raise ValueError("GGUF tokenizer has no verified exact counter")
    if profile == "qwen2" and (template is None or sha(template) != CHATML_TEMPLATE):
        raise ValueError("Ollama chat template has no verified exact tokenizer renderer")
    if profile == "qwen35":
        if template is not None or metadata.get("general.architecture") != "qwen35":
            raise ValueError("Qwen3.5 requires its verified embedded template")
        template = metadata.get("tokenizer.chat_template", "").encode()
        if sha(template) != QWEN35_TEMPLATE:
            raise ValueError("Qwen3.5 embedded template differs from verified reserve profile")
    tokens = metadata["tokenizer.ggml.tokens"]
    types = metadata["tokenizer.ggml.token_type"]
    if len(tokens) != len(types) or len(set(tokens)) != len(tokens):
        raise ValueError("Invalid GGUF token vocabulary")
    from transformers.integrations.ggml import GGUFQwen2Converter
    from tokenizers import AddedToken
    tokenizer = GGUFQwen2Converter({"tokens": tokens, "merges": metadata["tokenizer.ggml.merges"]}).converted()
    if profile == "qwen35":
        from tokenizers import Regex, pre_tokenizers
        tokenizer.pre_tokenizer = pre_tokenizers.Sequence([
            pre_tokenizers.Split(Regex(QWEN35_PATTERN), behavior="isolated", invert=False),
            pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False),
        ])
    tokenizer.add_special_tokens([AddedToken(token, normalized=False, special=True) for token, kind in zip(tokens, types) if kind in (3, 4)])
    rendered = ("<|im_start|>system\n" + system + "<|im_end|>\n" if system else "") + "<|im_start|>user\n" + prompt + "<|im_end|>\n<|im_start|>assistant\n"
    # Only Qwen2's supported direct envelope is rendered exactly. Qwen3.5
    # counts supplied text; the caller separately reserves template/CLI overhead.
    count_text = rendered if profile == "qwen2" else prompt
    text_tokens = len(tokenizer.encode(count_text, add_special_tokens=False).ids)
    if profile == "qwen35" and system:
        text_tokens += len(tokenizer.encode(system, add_special_tokens=False).ids)
    images = request.get("images", [])
    if images and profile != "qwen35":
        raise ValueError("Image token reserve requires the verified Qwen3.5 profile")
    return {"version":1, "method":"installed-gguf-qwen2-chatml" if profile == "qwen2" else "installed-gguf-qwen35-text", "promptHash":sha(prompt.encode()), "promptBytes":len(prompt.encode()), "inputTokens":text_tokens, "renderedPromptHash":sha(rendered.encode()) if profile == "qwen2" else sha(json.dumps({"prompt":prompt,"system":system}, ensure_ascii=False).encode()), "manifestDigest":sha(raw), "modelLayerDigest":model_layer["digest"], "metadataSha256":metadata_hash, "metadataBytes":metadata_bytes, "templateSha256":sha(template), "tokenizerJsonSha256":sha(tokenizer.to_str().encode()), "tokenizersVersion":versions["tokenizers"], "transformersVersion":versions["transformers"], "normalization":"input-already-NFC", "images":image_reserves(images)}

if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(1048577)
        if len(data) > 1048576:
            raise ValueError("Tokenizer input exceeds bound")
        print(json.dumps(count(json.loads(data))))
    except Exception as error:
        print(json.dumps({"error":str(error)}))
        sys.exit(2)
