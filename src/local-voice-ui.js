(() => {
  const studio = $('localVoiceStudio');
  let recording, stream, timer, sample, objectUrl, requestingMic = false, captureVersion = 0;
  const status = message => { $('voiceStudioStatus').textContent = message; };
  // The voice selected for THIS workspace stays visible in the studio, after the dialog closes and after a reload.
  let profiles = [];
  const showActiveVoice = () => { const media = state?.media || {}; const active = media.voiceProvider === 'voicebox' && media.voiceProfile ? (media.voiceProfileName || profiles.find(p => p.id === media.voiceProfile)?.name || 'your local voice') : ''; $('activeLocalVoice').textContent = active ? 'Selected for this workspace: ' + active + (profiles.find(p => p.id === media.voiceProfile)?.engine ? ' · ' + profiles.find(p => p.id === media.voiceProfile).engine : '') + '. Listen to the generated preview before approving its narration.' : 'No local voice is selected for this workspace yet; previews use the built-in narrator until you choose or create one.'; };
  const hideGauge = () => { $('voiceSetupGauge').hidden = true; $('voiceSetupTiming').hidden = true; $('voiceSetupStages').hidden = true; };
  // a beta tester, Sep 10: created → available → selected for this workspace → ready for narration, each stated from the server's answer.
  const select = async (voiceProfile, voiceProfileName) => {
    try {
      const result = await run('media', { mode: state.media.mode, voiceProvider: 'voicebox', voiceProfile, voiceProfileName });
      if (result) { $('quickForm').elements.voiceProvider.value = 'saved'; $('retryVoiceSelection').hidden = true; showActiveVoice(); status('✓ Saved and selected for this workspace: ' + voiceProfileName + '. ✓ Ready for narration: the next preview narrates with it.'); }
    } catch (error) { status('Not saved — ' + error.message); }
  };
  const stop = () => { clearTimeout(timer); if (recording?.state === 'recording') recording.stop(); stream?.getTracks().forEach(t => t.stop()); $('recordLocalVoice').textContent = 'Record my voice'; };
  const cancel = () => { captureVersion++; requestingMic = false; if (recording) recording.onstop = null; stop(); recording = null; $('createLocalVoice').disabled = busy; };
  studio.addEventListener('close', cancel);
  $('closeLocalVoice').onclick = () => studio.close();
  const showSample = file => { sample = file; if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = URL.createObjectURL(file); $('localVoiceRecording').src = objectUrl; $('localVoiceRecording').hidden = false; status('Recording ready. Listen, check the words, then create your voice.'); };
  const load = async (operation = 'voicebox-start') => {
    hideGauge(); $('localVoiceInputs').disabled = true; $('savedVoiceChoices').hidden = true; $('startLocalVoice').hidden = true;
    status(operation === 'voicebox-start' ? 'Preparing local Voicebox. The first installation downloads its local speech tools; keep this page open.' : 'Connecting to local Voicebox…');
    try {
      const result = await run(operation); if (!result) return;
      hideGauge(); profiles = result.profiles; showActiveVoice(); $('localVoiceInputs').disabled = false;
      const voices = result.profiles.filter(p => p.samples > 0);
      $('savedLocalVoices').replaceChildren(...voices.map(p => new Option(p.name + ' · ' + (p.engine || 'qwen'), p.id)));
      $('savedVoiceChoices').hidden = !voices.length; $('startLocalVoice').hidden = true;
      status('Connected to local Voicebox. Choose a saved voice or create one below.');
    } catch (error) { hideGauge(); showActiveVoice(); $('startLocalVoice').hidden = false; status('Local Voicebox is not ready: ' + error.message + ' Use Prepare local Voicebox to set it up here.'); }
  };
  document.querySelectorAll('[data-open-voice]').forEach(button => { button.onclick = () => { studio.showModal(); void load(); }; });
  $('startLocalVoice').onclick = () => load('voicebox-start');
  $('localVoiceFile').onchange = e => { cancel(); if (e.target.files[0]) showSample(e.target.files[0]); };
  $('recordLocalVoice').onclick = async () => {
    if (recording?.state === 'recording') return stop();
    if (requestingMic || recording) return;
    const version = ++captureVersion; requestingMic = true; $('createLocalVoice').disabled = true;
    $('recordLocalVoice').textContent = 'Waiting for microphone…';
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (version !== captureVersion || !studio.open) { acquired.getTracks().forEach(t => t.stop()); return; }
      requestingMic = false; stream = acquired; sample = null; $('localVoiceRecording').hidden = true;
      const chunks = [], capture = new MediaRecorder(stream); recording = capture;
      capture.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      capture.onstop = () => { if (version !== captureVersion) return; const type = capture.mimeType; showSample(new File(chunks, type.includes('mp4') ? 'recording.m4a' : 'recording.webm', { type })); stop(); recording = null; $('createLocalVoice').disabled = busy; };
      capture.onerror = () => { cancel(); status('Recording stopped. Retry the microphone or upload your recording.'); };
      recording.start(); $('recordLocalVoice').textContent = 'Stop recording'; status('Recording — read the words above. Recording stops automatically after 29 seconds.'); timer = setTimeout(stop, 29000);
    } catch (error) { if (version !== captureVersion) return; cancel(); status('Microphone unavailable: ' + error.message + '. You can upload a recording here.'); }
  };
  // Decode in the browser to validate duration and give the local service a portable PCM WAV.
  async function wav(file) {
    if (!file || file.size > 6 * 1024 * 1024) throw new Error('Record or upload 2–30 seconds of speech, up to 6 MB.');
    const context = new AudioContext({ sampleRate: 24000 });
    try {
      const audio = await context.decodeAudioData(await file.arrayBuffer());
      if (audio.duration < 2 || audio.duration > 30) throw new Error('The recording must be between 2 and 30 seconds.');
      const buffer = new ArrayBuffer(44 + audio.length * 2), view = new DataView(buffer);
      const label = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
      label(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); label(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, audio.length * 2, true);
      const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
      for (let i = 0; i < audio.length; i++) { const value = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length)); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
      const bytes = new Uint8Array(buffer); let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    } finally { await context.close(); }
  }
  $('localVoiceForm').onsubmit = async e => {
    e.preventDefault(); if (requestingMic || recording) return status('Finish recording before creating your voice.'); status('Checking your recording…');
    try {
      const data = formData('localVoiceForm'); data.consent = $('localVoiceForm').elements.consent.checked;
      data.audio = await wav(sample); data.filename = 'recording.wav';
      status('Saving your local voice…'); const result = await run('voicebox-create', data);
      if (result) {
        profiles = [...profiles.filter(p => p.id !== result.id), { id: result.id, name: result.name, samples: 1, engine: result.engine }];
        const selected = result.selected !== false; $('retryVoiceSelection').hidden = selected; $('retryVoiceSelection').onclick = () => select(result.id, result.name);
        if (selected) $('quickForm').elements.voiceProvider.value = 'saved';
        showActiveVoice();
        status(selected ? '✓ Voice created: ' + result.name + ' · ✓ Available in Voicebox · ✓ Saved and selected for this workspace · Engine: ' + (result.engine || 'qwen') + '. Listen to the generated preview before approving its narration. Close this studio to continue.' : '✓ Voice created: ' + result.name + ' · ✓ Available in Voicebox · Not selected for this workspace yet: ' + result.message + ' Press Retry selection; until then previews use your earlier narration choice.');
      }
    } catch (error) { status('Not saved — ' + error.message + ' Your recording is still here so you can retry.'); }
  };
  $('useLocalVoice').onclick = () => { const voiceProfile = $('savedLocalVoices').value; if (voiceProfile) void select(voiceProfile, profiles.find(p => p.id === voiceProfile)?.name || voiceProfile); };
})();
