/* Optional publication preferences. Raw profile text never enters the general connector state. */
(() => {
  const section = document.getElementById('personalizeStage');
  if (!section) return;
  const panel = document.createElement('details');
  panel.id = 'personalProfilePanel';
  panel.innerHTML = `<summary>About you &amp; remembered corrections · optional, Free and Pro</summary>
    <p>A little context can make your agents more useful. Skip this and create your preview whenever you are ready.</p>
    <p class="micro-help">Saved for this publication and visible to its owner and administrators. Your current brief always determines topics and places. Do not enter passwords or confidential personal information.</p>
    <form id="personalProfileForm">
      <label class="choice"><input type="checkbox" name="enabled">Use my saved writing preferences and reminders for new editions</label>
      <label>Tell your agents about yourself <small>Optional background, up to 600 characters. It stays here unless you explicitly share it with your agents below. It is not sent to newsletter writers or used as news evidence.</small><textarea name="about" maxlength="600" rows="3" placeholder="For example: I lead a small team and prefer practical explanations."></textarea></label>
      <div class="grid"><label>Explanation style<select name="explanation"><option value="">Use my publication settings</option><option value="plain">Plain language</option><option value="balanced">Explain unfamiliar terms</option><option value="technical">Technical language when useful</option></select></label>
      <label>Level of detail<select name="detail"><option value="">Use my publication settings</option><option value="brief">Get to the point</option><option value="balanced">Key points with context</option><option value="detailed">More explanation within my chosen length</option></select></label></div>
      <button type="submit">Save my preferences</button>
    </form>
    <p id="personalProfileStatus" role="status" aria-live="polite"></p>
    <details id="personalCorrectionPanel"><summary>Point out a mistake</summary><p>Choose what went wrong. The reminder shown below guides future checks; it does not certify a draft or change the model itself.</p>
      <form id="personalCorrectionForm"><label>What needs to improve?<select name="category" required></select></label><p id="personalCorrectionGuidance" class="micro-help"></p>
      <label>Your note <small>Optional. Kept here for your reference, not inserted into model instructions.</small><textarea name="note" maxlength="500" rows="2"></textarea></label>
      <button type="submit">Remember this correction</button></form>
      <div id="personalCorrectionList"></div>
    </details>
    <details><summary>What will the writer remember?</summary><p id="personalGuidance" style="white-space:pre-wrap"></p><p class="micro-help">Complete source evidence and your selected length take priority. Optional reminders may be omitted when a small model’s prompt is full. Existing editions retain their original settings.</p></details>
    <details id="personalProfileShare"><summary>Share with my coding agents · optional</summary><p>Review the profile below, select an agent, then share. This changes only this profile’s marked block in that agent’s global instructions on this computer. Existing instructions are kept. The harness does not import or follow the rest of those files.</p>
      <textarea id="personalProfilePreview" readonly rows="6" aria-label="Profile to share"></textarea>
      <form id="personalProfileShareForm"><fieldset><legend>Choose local agents</legend><div id="personalProfileTargets"></div></fieldset><button type="submit">Share this profile</button><button type="button" class="secondary" id="personalProfileUnshare">Remove selected shared copies</button></form>
      <p class="micro-help">Sharing is available to the owner on this local installation. A hosted service must offer a reviewed download instead of editing its server’s agent files. Later profile edits are not shared automatically.</p>
    </details>
    <form id="personalProfileClearForm"><details><summary>Delete saved personal information</summary><p>This removes your saved background, preferences and correction notes here. Existing edition evidence stays intact. Remove any shared agent copies above first if you want those deleted too.</p><button type="submit" class="secondary">Delete my saved preferences</button></details></form>`;
  (section.querySelector('#freeProOptions') || section.querySelector('#proGate')).before(panel);
  const byId = id => document.getElementById(id);
  const form = byId('personalProfileForm'), corrections = byId('personalCorrectionForm'), share = byId('personalProfileShareForm');
  let saved, view, dirty = false, pending = false;
  const status = (text, error = false) => { byId('personalProfileStatus').textContent = text; byId('personalProfileStatus').dataset.error = String(error); };
  form.addEventListener('input', () => { dirty = true; status('Unsaved preferences. Save to apply them to new editions.'); });
  form.addEventListener('change', () => { dirty = true; });
  const inputs = () => ({ enabled: form.elements.enabled.checked, about: form.elements.about.value, explanation: form.elements.explanation.value, detail: form.elements.detail.value });
  const targets = () => [...share.querySelectorAll('[name=target]:checked')].map(el => el.value);
  function render() {
    if (!saved) return;
    if (!dirty) { for (const key of ['about', 'explanation', 'detail']) form.elements[key].value = saved[key]; form.elements.enabled.checked = saved.enabled; }
    const category = corrections.elements.category.value;
    corrections.elements.category.replaceChildren(...view.categories.map(row => new Option(row.label, row.id)));
    if (view.categories.some(row => row.id === category)) corrections.elements.category.value = category;
    corrections.elements.category.onchange();
    byId('personalGuidance').textContent = view.guidance || 'No personal guidance is active. The publication settings and normal source checks apply.';
    byId('personalProfilePreview').value = view.markdown;
    const selected = targets();
    byId('personalProfileTargets').replaceChildren(...view.targets.map(target => {
      const label = document.createElement('label'); label.className = 'choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'target'; input.value = target.id;
      input.checked = selected.includes(target.id); input.disabled = !view.canShare || !target.available;
      const caption = document.createElement('span'); caption.textContent = target.label + (target.linkedHere ? ' — this profile is shared' : target.anotherWorkspace ? ' — sharing will replace another publication’s profile' : '') + (!target.available ? ' — ' + target.reason : '');
      label.append(input, caption); return label;
    }));
    byId('personalCorrectionList').replaceChildren(...saved.corrections.map(row => {
      const box = document.createElement('div'); box.className = 'card';
      const title = document.createElement('strong'); title.textContent = view.categories.find(c => c.id === row.category)?.label || row.category;
      const text = document.createElement('p'); text.textContent = row.note || 'No additional note.';
      const reminder = document.createElement('p'); reminder.className = 'micro-help'; reminder.textContent = view.categories.find(c => c.id === row.category)?.guidance || '';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Forget this correction';
      button.onclick = () => act('personal-profile-forget', { id: row.id });
      box.append(title, text, reminder, button); return box;
    }));
    for (const button of share.querySelectorAll('button')) button.disabled = !view.canShare;
  }
  async function refreshProfile() {
    if (!state || !['owner', 'admin'].includes(state.role)) { panel.hidden = true; if (byId('rememberPreviewMistake')) byId('rememberPreviewMistake').hidden = true; return; }
    panel.hidden = false;
    try { view = await (await api('/v1/personal-profile')).json(); saved = view.saved; render(); }
    catch (error) { status('Preferences are unavailable: ' + error.message + '. Your entries are kept.', true); }
  }
  async function act(operation, data, after) {
    if (pending || busy || !saved) return;
    if (dirty && operation !== 'personal-profile-save') { status('Save your preferences first so this action uses the version you reviewed.', true); return; }
    pending = true;
    try {
      const result = await run(operation, { expectedRevision: saved.revision, ...data });
      if (!result) return;
      if (operation === 'personal-profile-save' || operation === 'personal-profile-clear') dirty = false;
      after?.(); await refreshProfile(); status(result.message + (saved && !saved.enabled && operation === 'personal-profile-correct' ? ' Preferences are off; enable them to use this reminder.' : ''), result.partial === true);
    } catch (error) {
      status(error.message + ' Your entries are kept. Reload the page to resolve a changed-version conflict.', true);
    } finally { pending = false; }
  }
  form.onsubmit = event => { event.preventDefault(); act('personal-profile-save', inputs()); };
  corrections.elements.category.onchange = () => { byId('personalCorrectionGuidance').textContent = view?.categories.find(row => row.id === corrections.elements.category.value)?.guidance || ''; };
  corrections.onsubmit = event => { event.preventDefault(); act('personal-profile-correct', { requestId: crypto.randomUUID(), category: corrections.elements.category.value, note: corrections.elements.note.value }, () => { corrections.elements.note.value = ''; }); };
  share.onsubmit = event => { event.preventDefault(); act('personal-profile-share', { targets: targets() }); };
  byId('personalProfileUnshare').onclick = () => act('personal-profile-unshare', { targets: targets() });
  byId('personalProfileClearForm').onsubmit = event => { event.preventDefault(); act('personal-profile-clear', {}); };
  const report = document.createElement('button'); report.type = 'button'; report.className = 'secondary'; report.id = 'rememberPreviewMistake'; report.textContent = 'Point out a mistake';
  report.onclick = () => { stage('personalize'); panel.open = true; byId('personalCorrectionPanel').open = true; corrections.scrollIntoView({ block: 'center' }); corrections.elements.category.focus(); };
  byId('createStage').append(report);
  window.personalProfileUi = { refresh: refreshProfile };
  if (window.journeyReady) refreshProfile();
})();
