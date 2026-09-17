/* Loaded only by the authenticated local journey; transcripts live in this tab's memory. */
(() => {
  const panel = $('connectorPanel');
  let snapshot, pc, stream, channel, audio, sessionId, starting = false, generation = 0, voiceTimeout;
  const history = [], calls = new Set();
  let selectedAgents, agentsReady = false, connectingAgents = false;
  const selectedIds = () => [...$('agentChoice').querySelectorAll('input:checked')].map(i => i.value);
  const status = (message, error = false) => { $('connectorNotice').textContent = message; $('connectorNotice').classList.toggle('error', error); };
  const post = async (path, data, human = false) => (await api('/v1/connectors/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(human ? { 'x-harness-human': 'click' } : {}) }, body: JSON.stringify(data) })).json();
  const button = (text, fn, secondary = true) => { const b = document.createElement('button'); b.textContent = text; if (secondary) b.className = 'secondary'; b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { status(e.message, true); } finally { b.disabled = false; } }; return b; };
  const el = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  function view(name) {
    panel.hidden = name === 'workflow'; $('steps').hidden = name !== 'workflow'; $('moreStepsLabel').hidden = name !== 'workflow'; document.querySelector('footer').hidden = name !== 'workflow';
    document.querySelectorAll('[data-step]').forEach(s => s.hidden = name !== 'workflow' || Number(s.dataset.step) !== currentStep);
    document.querySelectorAll('[data-connector-view]').forEach(s => s.hidden = s.dataset.connectorView !== name);
    window.journeyView = view;
  document.querySelectorAll('[data-home]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.home === name)));
    if (name !== 'workflow') refreshConnections().catch(e => status(e.message, true));
  }
  document.querySelectorAll('[data-home]').forEach(b => b.onclick = () => view(b.dataset.home));
  function appendTranscript(role, text) {
    if (!text) return;
    const line = el('p', (role === 'user' ? 'You: ' : 'Harness: ') + text);
    line.dataset.role = role;
    $('voiceTranscript').append(line); line.scrollIntoView({ block: 'nearest' });
    history.push({ role, content: text }); if (history.length > 16) history.shift();
    while ($('voiceTranscript').children.length > 100) $('voiceTranscript').firstChild.remove();
  }
  function send(event) { if (channel?.readyState === 'open') channel.send(JSON.stringify(event)); }
  function stopVoice(message = 'Microphone stopped. Text remains available.') {
    generation++; starting = false; clearTimeout(voiceTimeout); stream?.getTracks().forEach(t => t.stop()); stream = undefined;
    if (channel) { channel.onclose = null; channel.close(); channel = undefined; } if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = undefined; }
    if (audio) { audio.pause(); audio.srcObject = null; audio = undefined; }
    $('startVoice').disabled = false; $('stopVoice').disabled = true; $('muteVoice').disabled = true; $('interruptVoice').disabled = true;
    $('muteVoice').textContent = 'Mute microphone'; status(message);
  }
  async function voiceEvent(event) {
    let e; try { e = JSON.parse(event.data); } catch { return; }
    if (e.type === 'conversation.item.input_audio_transcription.completed') appendTranscript('user', e.transcript);
    if (e.type === 'response.output_audio_transcript.done' || e.type === 'response.output_text.done') appendTranscript('assistant', e.transcript || e.text);
    if (e.type === 'input_audio_buffer.speech_started') status('Listening. You can interrupt at any time.');
    if (e.type === 'error') status(e.error?.message || 'Voice service error', true);
    if (e.type === 'response.function_call_arguments.done' && !calls.has(e.call_id)) {
      calls.add(e.call_id); let result;
      try {
        const args = JSON.parse(e.arguments);
        // Bind retries to this actual voice tool call; never accept a model's approval claim.
        if (e.name !== 'harness_setup' && !['harness_status', 'harness_engagement'].includes(e.name)) args.requestId = (sessionId + ':' + e.call_id).slice(0, 128);
        result = await post('tool', { name: e.name, arguments: args });
      } catch (error) { result = { error: error.message }; }
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: e.call_id, output: JSON.stringify({ trust: 'untrusted-data', result }) } }); send({ type: 'response.create' });
      refreshConnections().catch(e => status(e.message, true));
    }
  }
  $('startVoice').onclick = async () => {
    if (starting || pc) return; starting = true; const attempt = ++generation; $('startVoice').disabled = true; $('stopVoice').disabled = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('Voice is unavailable in this browser. Use the text box.');
      status('Requesting your microphone…');
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt !== generation) { acquired.getTracks().forEach(t => t.stop()); return; }
      stream = acquired; pc = new RTCPeerConnection(); sessionId = crypto.randomUUID(); calls.clear();
      audio = new Audio(); audio.autoplay = true; pc.ontrack = e => { audio.srcObject = e.streams[0]; audio.play().catch(() => { $('resumeVoiceAudio').hidden = false; status('Audio playback paused by the browser. Click Resume audio.'); }); };
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      channel = pc.createDataChannel('oai-events'); channel.onmessage = voiceEvent;
      voiceTimeout = setTimeout(() => stopVoice('Voice connection timed out. Use text or reconnect.'), 20000);
      channel.onopen = () => { clearTimeout(voiceTimeout); starting = false; $('muteVoice').disabled = false; $('interruptVoice').disabled = false; status('Voice connected. Ask about your workspace or prepare work for review.'); };
      channel.onclose = () => { if (pc) stopVoice('Voice disconnected. Your pending work is retained; reconnect when ready.'); };
      pc.onconnectionstatechange = () => { if (pc && ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) stopVoice('Voice connection lost. Microphone stopped; no actions replayed.'); };
      const peer = pc; await peer.setLocalDescription(await peer.createOffer());
      const answer = await post('voice/session', { sdp: peer.localDescription.sdp });
      if (attempt !== generation) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (error) { if (attempt === generation) { stopVoice(); status(error.name === 'NotAllowedError' ? 'Microphone permission denied. Use text below or allow microphone access in your browser.' : error.message, true); } }
  };
  $('stopVoice').onclick = () => stopVoice();
  $('muteVoice').onclick = () => { const track = stream?.getAudioTracks()[0]; if (track) { track.enabled = !track.enabled; $('muteVoice').textContent = track.enabled ? 'Mute microphone' : 'Unmute microphone'; } };
  $('interruptVoice').onclick = () => { send({ type: 'response.cancel' }); send({ type: 'output_audio_buffer.clear' }); status('Interrupted. Tell me what to change.'); };
  $('resumeVoiceAudio').onclick = () => audio?.play().catch(e => status(e.message, true));
  $('clearTranscript').onclick = () => { history.length = 0; $('voiceTranscript').replaceChildren(); };
  $('voiceText').onsubmit = async e => {
    e.preventDefault(); const text = $('voiceText').elements.message.value.trim(); if (!text) return;
    const savedHistory = history.slice(-12); appendTranscript('user', text); $('voiceText').elements.message.value = '';
    if (channel?.readyState === 'open') { send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }); send({ type: 'response.create' }); return; }
    const b = $('voiceText').querySelector('button'); b.disabled = true;
    try { const result = await post('voice/text', { text, history: savedHistory, requestId: crypto.randomUUID() }); appendTranscript('assistant', result.text); await refreshConnections(); }
    catch (error) { status(error.message, true); } finally { b.disabled = false; }
  };
  $('conversationSettings').onsubmit = async e => { e.preventDefault(); const result = await fire('conversation-settings', formData('conversationSettings')); if (result) { $('conversationSettings').elements.apiKey.value = ''; await refreshConnections(); status(result.message); } };
  $('remoteSettings').onsubmit = async e => { e.preventDefault(); try { const d = formData('remoteSettings'); const r = await post('remote/configure', { ...d, port: Number(d.port) }, true); status(r.message); await refreshConnections(); } catch (error) { status(error.message, true); } };
  for (const action of ['start', 'stop']) $('remote' + (action === 'start' ? 'Start' : 'Stop')).onclick = async () => { try { const r = await post('remote/' + action, {}, true); status(r.message); await refreshConnections(); } catch (error) { status(error.message, true); } };
  $('refreshConnections').onclick = () => refreshConnections().catch(e => status(e.message, true));
  async function refreshConnections() {
    agentsReady = false;
    $('connectSelected').disabled = true;
    try {
      if (!token) throw new Error('Open this workspace from the app launcher, or enter its access credential above, to choose your agents.');
      snapshot = await (await api('/v1/connectors')).json();
    } catch (error) {
      const message = el('p', error.message); message.setAttribute('role', 'alert');
      $('agentChoice').replaceChildren(message);
      $('agentSummary').textContent = 'Agent connection needed';
      if (!token) $('connection').open = true;
      status(error.message, true);
      return;
    }
    agentsReady = true;
    $('connectSelected').disabled = connectingAgents;
    if (!selectedAgents) {
      try { selectedAgents = JSON.parse(sessionStorage.getItem(workspace + ':agents') || 'null'); } catch { /* discard invalid preference */ }
      if (!Array.isArray(selectedAgents)) selectedAgents = [sessionStorage.getItem(workspace + ':agent') || snapshot.cards.find(c => c.installed)?.id || 'codex'];
    }
    selectedAgents = selectedAgents.filter(id => snapshot.cards.some(c => c.id === id));
    $('agentChoice').replaceChildren(el('legend', 'Select one or more agents'));
    for (const c of snapshot.cards) {
      const label = el('label', ''), input = document.createElement('input'); input.type = 'checkbox'; input.value = c.id; input.checked = selectedAgents.includes(c.id);
      label.append(input, el('span', c.name)); $('agentChoice').append(label);
    }
    const selectedCards = snapshot.cards.filter(c => selectedAgents.includes(c.id));
    $('agentSummary').textContent = selectedCards.length ? selectedCards.map(c => c.name).join(' + ') : 'Choose your agents';
    $('cloudConnection').hidden = !selectedAgents.includes('grok-bot');
    $('agentCards').replaceChildren();
    for (const c of selectedCards) {
      const card = el('article', ''); card.className = 'agent-card'; card.append(el('h3', c.name), el('p', c.status));
      const actions = el('div', ''); actions.className = 'actions';
      if (c.kind === 'remote') {
        actions.append(button('Verify', async () => { const r = await post('remote/verify', {}, true); status(r.message); await refreshConnections(); }));
        actions.append(button('Disconnect / restore', async () => { const r = await post('remote/stop', {}, true); status(r.message); await refreshConnections(); }));
      }
      else {
        actions.append(button('Verify', async () => { const r = await post('verify', { agent: c.id }, true); status(r.message); await refreshConnections(); }));
        actions.append(button('Disconnect / restore', async () => { const r = await post('restore', { agent: c.id }, true); status(r.message); await refreshConnections(); }));
      }
      const details = el('details', ''); details.append(el('summary', 'Setup instructions'), el('pre', c.setup), el('p', 'In the agent, ask: Call harness_status for my connected workspace. Approve the host’s normal trust prompt.'));
      details.append(button('Copy setup', async () => { await navigator.clipboard.writeText(c.setup); status('Setup command copied'); }));
      const docs = el('a', 'Official setup guide ↗'); docs.href = c.documentation; docs.target = '_blank'; docs.rel = 'noopener noreferrer'; details.append(' ', docs);
      if (c.proof) details.append(el('p', 'Last tool call: ' + c.proof.tool + ' · ' + c.proof.client + ' · ' + c.proof.at));
      card.append(actions, details); $('agentCards').append(card);
    }
    const voice = snapshot.conversation; for (const field of ['voice', 'model']) if (document.activeElement !== $('conversationSettings').elements[field]) $('conversationSettings').elements[field].value = voice[field];
    $('voiceKeyStatus').textContent = voice.keySaved ? 'Ready when you are. Microphone is off until you start.' : 'Connect your conversation account below before starting voice or text.';
    $('voiceConnection').open = !voice.keySaved;
    $('remoteStatus').textContent = (snapshot.remote.running ? 'Tunnel process running' : 'Cloud connection unavailable') + (snapshot.remote.error ? ': ' + snapshot.remote.error : '') + '. ' + snapshot.remote.accountVerification;
    $('remoteEndpoint').textContent = snapshot.remote.origin ? snapshot.remote.origin + '/mcp' : 'Configure your stable HTTPS hostname below.';
    $('remoteGrants').replaceChildren();
    for (const g of snapshot.remote.grants) { const row = el('div', `${g.actor} · ${g.scopes.join(', ')} · ${g.revoked ? 'revoked' : g.expiresAt * 1000 < Date.now() ? 'expired' : 'expires ' + new Date(g.expiresAt * 1000).toLocaleString()}${g.lastCall ? ' · tool call ' + g.lastCall.tool + ' at ' + g.lastCall.at : ' · no tool call verified'}`); if (!g.revoked) row.append(button('Revoke grant', async () => { await post('remote/revoke', { id: g.id }, true); await refreshConnections(); })); $('remoteGrants').append(row); }
    $('humanQueue').replaceChildren();
    for (const p of snapshot.remote.pending) {
      const card = el('article', ''); card.className = 'card'; card.append(el('h3', 'Connect ' + p.name), el('p', `Grant your workspace/member access for one hour: ${p.scopes.join(', ')}. Publishing, reply sending and access changes remain local.`), el('p', 'Return to: ' + p.redirectUri));
      for (const allow of [true, false]) card.append(button(allow ? 'Authorize this connection' : 'Decline', async () => { const r = await post('remote/consent', { id: p.id, expectedHash: p.hash, allow }, true); location.assign(r.redirect); }, !allow));
      $('humanQueue').append(card);
    }
    for (const r of snapshot.review) {
      const card = el('article', ''); card.className = 'card'; card.append(el('h3', r.action.operation), el('p', 'Requested by ' + r.actor + ' via ' + r.connection), el('pre', JSON.stringify(r.action, null, 2)));
      if (r.evidence) card.append(el('blockquote', r.evidence.comment), el('h4', 'Exact saved reply'), el('p', r.evidence.reply || 'No reply prepared'), el('p', 'Sending account: ' + r.evidence.accountId));
      const review = el('a', r.evidence ? 'Open the viewer response' : 'Inspect the exact package first'); review.href = r.evidence?.url || '/control?workspace=' + encodeURIComponent(workspace) + (token ? '#token=' + encodeURIComponent(token) : ''); card.append(review);
      for (const allow of [true, false]) card.append(button(allow ? 'Confirm exact action' : 'Decline', async () => {
        const result = await post('review', { id: r.id, expectedHash: r.hash, allow }, true);
        if (result.token) { $('newToken').value = result.token; $('credential').showModal(); }
        status(result.job ? 'Action submitted. Review job ' + result.job + ' before another attempt.' : result.message || 'Action completed.'); await refreshConnections();
      }, !allow));
      $('humanQueue').append(card);
    }
    if (!$('humanQueue').children.length) $('humanQueue').append(el('p', 'No pending human actions.'));
    $('reviewCount').textContent = snapshot.review.length + snapshot.remote.pending.length;
  }
  addEventListener('pagehide', () => stopVoice());
  // Keep the main browser journey usable while refreshing connection receipts independently.
  $('agentChoice').onchange = () => { selectedAgents = selectedIds(); sessionStorage.setItem(workspace + ':agents', JSON.stringify(selectedAgents)); refreshConnections().catch(e => status(e.message, true)); };
  $('connectSelected').onclick = async () => {
    if (connectingAgents || !agentsReady) return;
    const agents = selectedIds();
    if (!agents.length) { status('Choose at least one agent above.', true); return; }
    connectingAgents = true;
    view('agents'); $('agentPicker').open = false;
    $('connectSelected').disabled = true;
    const results = [];
    try {
      for (const agent of agents) {
        const name = snapshot.cards.find(c => c.id === agent)?.name || agent;
        if (agent === 'grok-bot') { $('cloudConnection').open = true; results.push(name + ': complete the cloud connection below.'); continue; }
        status('Connecting ' + name + '…');
        try { const result = await post('configure', { agent }, true); results.push(name + ': ' + result.message); }
        catch (e) { results.push(name + ': ' + e.message); }
      }
      await refreshConnections(); status(results.join(' · '));
    } finally { connectingAgents = false; $('connectSelected').disabled = !agentsReady; }
  };
  refreshConnections().catch(e => status(e.message, true));
  const initial = query.get('oauth') ? 'review' : 'workflow';
  view(initial);
})();
