/* Plain-language guidance uses the existing workspace actions and approval boundaries. */
(() => {
  const tour = $('journeyTour');
  const tourFailed = () => { $('tourError').hidden = false; };
  tour.addEventListener('error', tourFailed);
  tour.querySelector('source')?.addEventListener('error', tourFailed);
  tour.addEventListener('loadeddata', () => { $('tourError').hidden = true; });
  $('startJourney').onclick = () => { tour.pause(); window.journeyView?.('workflow'); document.querySelector('#steps button')?.click(); $('usageForm').elements.description.focus(); $('usageForm').scrollIntoView({behavior:'smooth'}); };
  if (tour.querySelector('source')) fetch('/journey-assets/walkthrough-chapters.json').then(async response => {
    if(!response.ok)return;
    const manifest=await response.json();
    $('tourChapter').replaceChildren(...manifest.chapters.map((c,i)=>new Option((i+1)+'. '+c.title,String(c.start))));
    $('tourChapterLabel').hidden=false;
    $('tourChapter').onchange=()=>{
      const time=Number($('tourChapter').value);
      if(tour.readyState)tour.currentTime=time;
      else tour.addEventListener('loadedmetadata',()=>{tour.currentTime=time},{once:true});
      tour.play().catch(tourFailed);
    };
  }).catch(()=>{});
  tour.addEventListener('ended', () => { $('tourNext').hidden = false; });
  $('editorialForm').onsubmit = async e => { e.preventDefault(); const changed=sourceTopicsChanged(); const result=await fire('editorial', { ...formData('editorialForm'), enabledSources: [...$('editorialForm').querySelectorAll('[name=enabledSources]:checked')].map(i=>i.value) }); if(result&&changed&&state.publicApis!=='off')await fire('sources',{discoverOnly:true}); };
  window.renderCosts = costs => {
    if (!costs) return;
    $('costCalls').textContent=costs.recordedCalls; $('costTotal').textContent=costs.reportedCostUsd===null?'Not reported':'$'+costs.reportedCostUsd.toFixed(4); $('costUnknown').textContent=costs.unpricedCalls; $('costScope').textContent=costs.scope;
    $('costRows').replaceChildren(...costs.rows.map(row=>{const tr=document.createElement('tr');for(const value of [row.at, row.provider+' / '+row.model, (row.inputTokens??'Unknown')+' / '+(row.outputTokens??'Unknown'),row.reportedCostUsd===null?'Not reported':'$'+row.reportedCostUsd.toFixed(4)]){const td=document.createElement('td');td.textContent=value;tr.append(td)}return tr}));
  };
  const titles = { youtube: 'YouTube', linkedin: 'LinkedIn', instagram: 'Instagram', threads: 'Threads', x: 'X', tiktok: 'TikTok', reddit: 'Reddit' };
  const descriptions = { youtube: 'Video + comments', linkedin: 'Professional audience', instagram: 'Reels', threads: 'Short updates', x: 'Video + replies', tiktok: 'Private posts in this beta', reddit: 'Community posts' };
  const explanations = {
    youtube: 'YouTube is owned by Google. A Google client ID identifies the small application you create in Google Cloud; it is not your Gmail address. Its client secret is that application’s password, not your Google password. Because you run this harness yourself, Google needs your application identity before it can ask permission to upload to your channel. These two fields are only needed for YouTube. Your agent can guide you through enabling the YouTube Data API and creating an OAuth client; you enter the credentials here and complete Google’s own consent screen.',
    linkedin: 'LinkedIn video posting uses a LinkedIn developer application and the posting permissions granted to your account. A client ID identifies that app; its secret authenticates it. A personal account does not automatically have permission to post as a company. Newsletter publishing has a separate browser sign-in below.',
    instagram: 'Instagram publishing needs a supported professional account, its account ID, and a Meta access token with publishing permission. A token is a temporary permission credential, not your account password. Enter its actual expiry so the app can detect when it needs reconnecting.',
    threads: 'Threads needs a Meta developer application with Threads publishing permission. Its app ID identifies it; the secret authenticates it. Complete the service’s own sign-in after saving these details.',
    x: 'X requires a developer application and an account plan that permits the API operations you need. The client ID identifies your application. Your agent can explain its permissions and current account requirements before you connect.',
    tiktok: 'TikTok requires an approved developer app and a public HTTPS callback. This beta sends private posts only. Your agent can explain that setup; you can leave TikTok for later and still make a private preview.',
    reddit: 'Reddit needs a developer application, a description of the application (user agent), and the community where you intend to post. Follow that community’s rules. Selecting Reddit does not submit anything.',
  };
  const labels = { GOOGLE_CLIENT_ID: 'Google application ID', GOOGLE_CLIENT_SECRET: 'Google application secret', IG_USER_ID: 'Instagram professional account ID', TIKTOK_REDIRECT_URI: 'Approved TikTok return address', REDDIT_USER_AGENT: 'Application description for Reddit', REDDIT_SUBREDDIT: 'Community name' };
  const updateMedia = () => {
    const f = $('mediaForm');
    $('localVoiceSetup').hidden = Boolean($('cloudVoice').value) || f.elements.voiceProvider.value !== 'voicebox';

    f.elements.voiceProfile.required = !$('localVoiceSetup').hidden;
  };
  $('mediaForm').addEventListener('change', updateMedia);
  $('cloudVoice').onchange = updateMedia;
  $('channelsForm').onsubmit = e => { e.preventDefault(); fire('channels', { selected: [...$('channelSelections').querySelectorAll('input:checked')].map(i => i.value) }); };
  $('stageChannelsForm').onsubmit = e => { e.preventDefault(); fire('channels', { selected: [...$('stageChannels').querySelectorAll('input:checked')].map(i => i.value) }); };
  $('checkLocalVoice').onclick = async () => {
    const result = await fire('voicebox-check');
    if (result) {
      $('localVoiceProfiles').replaceChildren(...result.profiles.map(p => new Option(p.name, p.name)));
      $('localVoiceStatus').textContent = result.message + (result.profiles.length ? ' Available profiles: ' + result.profiles.map(p => p.name).join(', ') : ' Create a profile in Voicebox, then check again.');
    } else $('localVoiceStatus').textContent = 'Voicebox is not available yet. Open the local voice studio, create your voice, then check again. You can also explicitly choose a built-in narrator.';
  };
  $('reloadPlan').onclick = () => refresh().then(() => notice('Showing the latest saved settings from your agent.')).catch(e => notice(e.message, true));
  for (const b of document.querySelectorAll('[data-copy-brief]')) b.onclick = async () => {
    const saved = state?.useCase?.description || $('usageForm').elements.description.value;
    const prompt = `Help me set up this content workspace. First call harness_setup and read its saved use case and guidance. Explain your recommendation, ask only missing questions one at a time, then use harness_configure for my publication and narrated-slide settings. Verify actual sources with harness_sources. Keep credentials, voice-profile selection, channel consent, access changes and publishing in my browser. Never claim a task completed without its receipt.\n\nMy use case:\n${saved || '(Ask me to describe my audience and desired result.)'}`;
    try { await navigator.clipboard.writeText(prompt); notice('Copied. Paste this into your connected agent; it can read and configure this workspace.'); }
    catch { const d = document.createElement('dialog'), t = document.createElement('textarea'), close = document.createElement('button'); t.value = prompt; t.readOnly = true; t.setAttribute('aria-label', 'Instructions for your agent'); close.textContent = 'Close'; close.onclick = () => { d.close(); d.remove(); }; d.append(t, close); document.body.append(d); d.showModal(); t.select(); }
  };
  const describeChannel = () => {
    const id = $('channelChoice').value;
    $('channelExplanation').textContent = explanations[id] || '';
    for (const label of $('channelFields').querySelectorAll('label')) { const input = label.querySelector('input'); if (labels[input.name]) label.firstChild.textContent = labels[input.name]; }
  };
  $('channelChoice').addEventListener('change', describeChannel);
  window.refreshGuidance = () => {
    window.journeyReady = true;
    $('savedUseCase').textContent = state.useCase?.description || 'Save your use case first, then ask your agent to read it.';
    $('cloudVoice').value = ['elevenlabs', 'resemble'].includes(state.media.voiceProvider) ? state.media.voiceProvider : '';
    if (!state.configured && !state.media.voiceProfile) $('mediaForm').elements.voiceProvider.value = 'voicebox';
    fill('editorialForm',{topics:state.topics.join('\n'),avoid:state.avoid.join('\n'),notes:state.notes,feeds:state.feeds.map(f=>f.url).join('\n')});
    for(const input of $('editorialForm').querySelectorAll('[name=enabledSources]')) input.checked=state.enabledSources.includes(input.value);
    const service=state.media.avatarService;
    for(const option of $('mediaForm').elements.mode.options) option.disabled=option.value!=='cards'&&!service.available;
    $('avatarAvailability').textContent=service.available?'Pro setup saved. Production validates the connection when you generate.':service.active?'Pro is active. MyOwnAI Labs still needs to complete your presenter setup.':'Pro activation is required for presenter production. You can watch the examples below and start with narrated slides.';
    updateMedia();
    $('channelSelections').replaceChildren(...state.channels.map(c => {
      const label = document.createElement('label'); label.className = 'choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = c.id; input.checked = c.enabled; input.name = 'selected';
      const text = document.createElement('span'), strong = document.createElement('strong'), small = document.createElement('small'); strong.textContent = titles[c.id]; small.textContent = descriptions[c.id]; text.append(strong, small); label.append(input, text); return label;
    }));
    // The executive Publish stage: the same destinations and labels, plus plain connection status.
    $('stageChannels').replaceChildren(...state.channels.map(c => {
      const label = document.createElement('label'); label.className = 'choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = c.id; input.checked = c.enabled; input.name = 'selected';
      input.onchange = () => { $('stageChannelActions').hidden = [...$('stageChannels').querySelectorAll('input')].every(i => i.checked === Boolean(state.channels.find(ch => ch.id === i.value)?.enabled)); };
      const text = document.createElement('span'), strong = document.createElement('strong'), small = document.createElement('small'); strong.textContent = titles[c.id];
      small.textContent = descriptions[c.id] + ' · ' + (c.tokenSaved ? 'Connected' : c.savedFields.length === c.fields.length ? 'Ready to connect' : 'Not connected yet · connect in Advanced settings');
      text.append(strong, small); label.append(input, text); return label;
    }));
    $('stageChannelActions').hidden = true;
    $('stageConnect').replaceChildren(...state.channels.filter(c => c.enabled && !c.tokenSaved && c.savedFields.length === c.fields.length && c.id !== 'instagram').map(c => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = 'Connect ' + titles[c.id]; b.onclick = () => fire('connect', { platform: c.id }); return b;
    }));
    $('stageChannelHelp').textContent = state.channels.some(c => c.enabled) ? 'Saved destinations receive only what you publish in the review step below.' : 'No destination selected yet. Your preview stays private until you choose one and publish.';
    for (const option of $('channelChoice').options) option.textContent = titles[option.value];
    describeChannel();
    $('draftReadiness').textContent = state.configured ? `Your preview: ${state.publisher.publication}. Writer: ${writerNames[state.model.provider] || state.model.provider}. ${state.feeds.length + state.connectedApis.length + (state.webSources?.length || 0)} saved sources; ${state.media.voiceProvider === 'voicebox' ? 'your local voice' : 'your selected narration'}; ${state.media.mode === 'cards' ? 'illustrated slides' : 'a speaking presenter'}. Generation still checks the sources, model and finished media.` : 'Save your publication details first, or ask your connected agent to configure them from your use case.';
  };
})();
