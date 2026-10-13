/**
 * Collab-Editor Interactive Application Logic
 * Palette: Pinterest Minimalist Luxury (Smoky Black, Olive Drab, Bone, Floral White)
 * Features: 
 *   - Real-time Markdown Formatting Toolbar
 *   - Interactive Feature Verification Guide & Checklist
 *   - Offline / Online Mesh Network Simulation
 *   - Dynamic Document Management (Create, Open, Search, Filter)
 *   - Live Simulated Peer Collaboration (Alice & Bob)
 *   - Real Toast Notifications
 *   - Live Typography Scaling & Vault Settings
 */

// ==========================================
// 1. STATE & DATA STORE
// ==========================================

const AppState = {
  currentView: 'landing',
  isOnline: true,
  peersActive: true,
  currentDocId: 'rfc-crdt-sequence-rga',
  documents: [
    {
      id: 'rfc-crdt-sequence-rga',
      title: 'rfc-crdt-sequence-rga.md',
      encrypted: true,
      category: 'shared',
      time: 'Edited 2m ago',
      peers: ['You', 'AL', 'BO'],
      content: `# RFC-9022: Replicated Growable Array (RGA) CRDT Specification\n\n## 1. Abstract\nThis document formalizes the deterministic sequence CRDT engineered for Collab-Editor.\nAll mutation atoms are causally linked using Lamport vector clocks: VC(Node_A) = [0:14, 0:9].\n\n## 2. Zero-Knowledge Cryptography\nKeystrokes are encrypted with ephemeral ChaCha20-Poly1305 symmetric keys.\nThe decryption secret is never disclosed to WebSocket relay nodes.\n\n## 3. Offline & P2P Synchronization\n- Local state persists directly to IndexedDB.\n- Peer-to-peer data channels bypass central cloud queues.`
    },
    {
      id: 'distributed-consensus-notes',
      title: 'distributed-consensus-notes.md',
      encrypted: true,
      category: 'recent',
      time: 'Edited 18m ago',
      peers: ['You'],
      content: `# Distributed Consensus Architecture Notes\n\nComparing Lamport scalar clocks vs Matrix vector clocks for causal convergence in partition-heavy networks.\n\nKey takeaways:\n- Deterministic tie-breaking on Peer ID hash.\n- Local storage tombstone pruning via garbage collection passes.`
    },
    {
      id: 'investigation-report-q3',
      title: 'investigation-report-q3.enc',
      encrypted: true,
      category: 'shared',
      time: 'Edited 2h ago',
      peers: ['BO'],
      content: `# Confidential Audit Report [Q3]\n\nZero-knowledge verified hardware vault logs:\n- SHA256: 9F4C:87BA:3301:089C:EE45:FA71:8892:AC38\n- All local deltas authenticated with Ed25519 signatures.`
    }
  ],
  verifiedFeatures: new Set(),
  activeFilter: 'all',
  activeTypeFilter: 'all',
  searchQuery: ''
};

// ==========================================
// 2. VIEW SWITCHING & TOASTS
// ==========================================

function switchView(viewName) {
  AppState.currentView = viewName;
  document.querySelectorAll('.app-view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

  const targetView = document.getElementById(`view-${viewName}`);
  const targetNav = document.getElementById(`nav-${viewName}`);

  if (targetView) targetView.classList.add('active');
  if (targetNav) targetNav.classList.add('active');

  if (viewName === 'editor') {
    updateLineNumbers();
    updateEditorMetrics();
  } else if (viewName === 'dashboard') {
    renderDocuments();
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>●</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.2s ease-out';
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}

// ==========================================
// 3. MARKDOWN TOOLBAR FORMATTING
// ==========================================

function formatMarkdown(type) {
  const editor = document.getElementById('editor-surface');
  if (!editor) return;

  const selection = window.getSelection();
  const selectedText = selection ? selection.toString() : '';

  let replacement = '';
  switch (type) {
    case 'bold':
      replacement = selectedText ? `**${selectedText}**` : `**bold text**`;
      break;
    case 'italic':
      replacement = selectedText ? `*${selectedText}*` : `*italic text*`;
      break;
    case 'h1':
      replacement = `\n# ${selectedText || 'New Heading 1'}\n`;
      break;
    case 'h2':
      replacement = `\n## ${selectedText || 'New Heading 2'}\n`;
      break;
    case 'code':
      replacement = selectedText ? `\`${selectedText}\`` : `\`code\``;
      break;
    case 'codeblock':
      replacement = `\n\`\`\`javascript\n${selectedText || '// Code Block'}\n\`\`\`\n`;
      break;
    case 'quote':
      replacement = `\n> ${selectedText || 'Quoted text'}\n`;
      break;
    case 'list':
      replacement = `\n- ${selectedText || 'List item'}\n`;
      break;
  }

  if (replacement) {
    document.execCommand('insertText', false, replacement);
    handleEditorInput();
    showToast(`Formatted markdown: ${type}`);
    markFeatureVerified('format');
  }
}

function execUndo() {
  document.execCommand('undo');
  handleEditorInput();
  showToast('Undo executed');
}

function execRedo() {
  document.execCommand('redo');
  handleEditorInput();
  showToast('Redo executed');
}

function downloadMarkdown() {
  const title = document.getElementById('active-doc-title').value || 'document.md';
  const content = document.getElementById('editor-surface').innerText;
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = title.endsWith('.md') ? title : `${title}.md`;
  link.click();
  showToast(`Exported ${link.download}`);
}

// ==========================================
// 4. EDITOR METRICS & LINE NUMBERS
// ==========================================

function handleEditorInput() {
  updateLineNumbers();
  updateEditorMetrics();
  markFeatureVerified('edit');
}

function handleEditorCursor() {
  const editor = document.getElementById('editor-surface');
  if (!editor) return;

  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(editor);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    const textBefore = preCaretRange.toString();
    const lines = textBefore.split('\n');
    const lineNum = lines.length;
    const colNum = lines[lines.length - 1].length + 1;
    document.getElementById('stats-cursor').innerText = `Ln ${lineNum}, Col ${colNum}`;
  }
}

function updateLineNumbers() {
  const editor = document.getElementById('editor-surface');
  const gutter = document.getElementById('line-numbers');
  if (!editor || !gutter) return;

  const lines = editor.innerText.split('\n').length;
  let numbersHtml = '';
  for (let i = 1; i <= Math.max(lines, 16); i++) {
    numbersHtml += `<div>${i}</div>`;
  }
  gutter.innerHTML = numbersHtml;
}

function updateEditorMetrics() {
  const editor = document.getElementById('editor-surface');
  if (!editor) return;

  const text = editor.innerText;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;

  document.getElementById('stats-words').innerText = `${words} Words · ${chars} Chars`;
}

function updateActiveDocTitle(newTitle) {
  const doc = AppState.documents.find(d => d.id === AppState.currentDocId);
  if (doc) {
    doc.title = newTitle;
    showToast(`Renamed to ${newTitle}`);
  }
}

// ==========================================
// 5. SIMULATED PEER COLLABORATION
// ==========================================

let peerSimInterval = null;

function togglePeerTypingSimulation() {
  const btn = document.getElementById('btn-peer-simulate');
  const cursorAlice = document.getElementById('cursor-alice');
  const cursorBob = document.getElementById('cursor-bob');

  if (peerSimInterval) {
    clearInterval(peerSimInterval);
    peerSimInterval = null;
    btn.innerHTML = '<span>👥 Simulate Peers</span>';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-glass');
    showToast('Peer collaboration paused');
  } else {
    btn.innerHTML = '<span>⏸ Stop Simulation</span>';
    btn.classList.remove('btn-glass');
    btn.classList.add('btn-primary');
    showToast('Alice & Bob are typing in the document...');
    markFeatureVerified('peers');

    // Simulate animated typing and moving cursors
    let step = 0;
    const sampleDeltas = [
      '\n- [P2P-Delta] Alice synchronized vector clock atom #143',
      '\n- [P2P-Delta] Bob verified ChaCha20-Poly1305 MAC tag',
      '\n- [P2P-Delta] Deterministic Lamport merge completed'
    ];

    peerSimInterval = setInterval(() => {
      const editor = document.getElementById('editor-surface');
      if (editor && step < sampleDeltas.length) {
        editor.innerText += sampleDeltas[step];
        handleEditorInput();

        // Move cursors dynamically
        if (cursorBob) {
          cursorBob.style.top = `${260 + (step * 24)}px`;
          cursorBob.style.left = `${320 + (step * 30)}px`;
        }
        if (cursorAlice) {
          cursorAlice.style.top = `${140 + (step * 20)}px`;
          cursorAlice.style.left = `${280 + (step * 25)}px`;
        }
        step++;
      } else {
        step = 0;
      }
    }, 2000);
  }
}

// ==========================================
// 6. OFFLINE / ONLINE MESH SIMULATION
// ==========================================

function toggleNetworkSimulation() {
  AppState.isOnline = !AppState.isOnline;
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const syncDot = document.getElementById('editor-sync-dot');
  const syncText = document.getElementById('editor-sync-text');
  const peersStat = document.getElementById('editor-peers-stat');
  const storageStat = document.getElementById('editor-storage-stat');

  if (AppState.isOnline) {
    statusDot.className = 'dot dot-emerald';
    statusText.innerText = 'Mesh Active (3 Peers)';
    if (syncDot) syncDot.className = 'dot dot-emerald';
    if (syncText) syncText.innerText = '100% Converged';
    if (peersStat) peersStat.innerText = '3 Peers · 8ms';
    if (storageStat) storageStat.innerText = 'IndexedDB Local';
    showToast('Reconnected to P2P Mesh. Operations synchronized.');
  } else {
    statusDot.className = 'dot dot-warning';
    statusText.innerText = 'Offline (Queued to Vault)';
    if (syncDot) syncDot.className = 'dot dot-warning';
    if (syncText) syncText.innerText = 'Queued Locally';
    if (peersStat) peersStat.innerText = '0 Peers (Offline)';
    if (storageStat) storageStat.innerText = 'IndexedDB Only';
    showToast('Network disconnected. Edits safely stored in IndexedDB.');
  }

  markFeatureVerified('offline');
}

// ==========================================
// 7. DYNAMIC DOCUMENT MANAGEMENT
// ==========================================

function renderDocuments() {
  const container = document.getElementById('docs-list');
  if (!container) return;

  let filtered = AppState.documents.filter(doc => {
    // Category filter
    if (AppState.activeFilter === 'recent' && doc.category !== 'recent') return false;
    if (AppState.activeFilter === 'shared' && doc.category !== 'shared') return false;
    // Type filter
    if (AppState.activeTypeFilter === 'encrypted' && !doc.encrypted) return false;
    // Search filter
    if (AppState.searchQuery) {
      const q = AppState.searchQuery.toLowerCase();
      return doc.title.toLowerCase().includes(q) || doc.content.toLowerCase().includes(q);
    }
    return true;
  });

  document.getElementById('count-all').innerText = AppState.documents.length;
  document.getElementById('count-shared').innerText = AppState.documents.filter(d => d.category === 'shared').length;

  container.innerHTML = filtered.map(doc => `
    <div class="doc-card" onclick="openDoc('${doc.id}')">
      <div class="doc-card-top">
        <span class="badge">${doc.encrypted ? 'ChaCha20-Poly1305' : 'Plaintext'}</span>
        <div class="doc-menu-btn" onclick="event.stopPropagation(); deleteDoc('${doc.id}')" title="Delete Document">×</div>
      </div>
      <h4 class="doc-title">${doc.title}</h4>
      <p class="doc-snippet">${doc.content.slice(0, 100).replace(/#/g, '')}...</p>
      <div class="doc-card-footer">
        <span class="doc-time">${doc.time}</span>
        <div class="peer-avatars-row">
          ${doc.peers.map(p => `<span class="avatar-sm">${p}</span>`).join('')}
        </div>
      </div>
    </div>
  `).join('');
}

function openDoc(docId) {
  const doc = AppState.documents.find(d => d.id === docId);
  if (!doc) return;

  AppState.currentDocId = docId;
  document.getElementById('active-doc-title').value = doc.title;
  document.getElementById('editor-surface').innerText = doc.content;

  switchView('editor');
  showToast(`Opened ${doc.title}`);
}

function createNewDoc() {
  const newId = `doc-${Date.now()}`;
  const newDoc = {
    id: newId,
    title: `untitled-${AppState.documents.length + 1}.md`,
    encrypted: true,
    category: 'recent',
    time: 'Created just now',
    peers: ['You'],
    content: `# Untitled Document\n\nBegin typing here. All operations persist to local IndexedDB and sync over P2P mesh.`
  };

  AppState.documents.unshift(newDoc);
  renderDocuments();
  openDoc(newId);
  showToast(`Created new document: ${newDoc.title}`);
}

function createNewEncryptedDoc() {
  const newId = `enc-${Date.now()}`;
  const newDoc = {
    id: newId,
    title: `airgapped-room-${AppState.documents.length + 1}.enc`,
    encrypted: true,
    category: 'shared',
    time: 'Created just now',
    peers: ['You', 'AL'],
    content: `# Air-Gapped Encrypted Room\n\nDecryption key fragment: #k=${Math.random().toString(36).substring(2, 15)}\nZero-knowledge verified hardware vault.`
  };

  AppState.documents.unshift(newDoc);
  renderDocuments();
  openDoc(newId);
  showToast(`Created encrypted room: ${newDoc.title}`);
}

function deleteDoc(docId) {
  if (AppState.documents.length <= 1) {
    showToast('Cannot delete last remaining document');
    return;
  }
  AppState.documents = AppState.documents.filter(d => d.id !== docId);
  renderDocuments();
  showToast('Document deleted');
}

function filterDocs(cat) {
  AppState.activeFilter = cat;
  document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(`filter-${cat}`);
  if (target) target.classList.add('active');
  renderDocuments();
}

function filterType(type) {
  AppState.activeTypeFilter = type;
  document.getElementById('btn-filter-all').classList.toggle('active', type === 'all');
  document.getElementById('btn-filter-enc').classList.toggle('active', type === 'encrypted');
  renderDocuments();
}

function handleSearch(q) {
  AppState.searchQuery = q;
  renderDocuments();
}

// ==========================================
// 8. INTERACTIVE FEATURE VERIFICATION GUIDE
// ==========================================

function openGuideDrawer() {
  const drawer = document.getElementById('guide-drawer-overlay');
  if (drawer) drawer.classList.add('active');
}

function closeGuideDrawer() {
  const drawer = document.getElementById('guide-drawer-overlay');
  if (drawer) drawer.classList.remove('active');
}

function markFeatureVerified(featureKey) {
  AppState.verifiedFeatures.add(featureKey);

  const item = document.getElementById(`check-${featureKey}`);
  const badge = document.getElementById(`badge-${featureKey}`);

  if (item) item.classList.add('completed');
  if (badge) {
    badge.innerText = 'VERIFIED';
    badge.className = 'check-badge completed';
  }

  const count = AppState.verifiedFeatures.size;
  const progressText = document.getElementById('guide-progress-text');
  if (progressText) {
    progressText.innerText = `${count} of 6 Verified`;
  }
}

function triggerTestEdit() {
  closeGuideDrawer();
  switchView('editor');
  const editor = document.getElementById('editor-surface');
  if (editor) {
    editor.focus();
    document.execCommand('insertText', false, ' [CRDT-Verified-Edit]');
    handleEditorInput();
  }
  showToast('Verified: Keystroke registered & word metrics updated');
  markFeatureVerified('edit');
}

function triggerTestFormat() {
  closeGuideDrawer();
  switchView('editor');
  formatMarkdown('bold');
  markFeatureVerified('format');
}

function triggerTestPeers() {
  closeGuideDrawer();
  switchView('editor');
  togglePeerTypingSimulation();
}

function triggerTestShare() {
  closeGuideDrawer();
  openModal('share-modal');
  copyShareLink();
  markFeatureVerified('share');
}

function triggerTestOffline() {
  closeGuideDrawer();
  toggleNetworkSimulation();
  markFeatureVerified('offline');
}

function triggerTestSettings() {
  closeGuideDrawer();
  openModal('settings-modal');
  switchSettingsTab('tab-editor');
  updateFontSize(17);
  document.getElementById('font-slider').value = 17;
  markFeatureVerified('settings');
}

function verifyAllFeatures() {
  ['edit', 'format', 'peers', 'share', 'offline', 'settings'].forEach(k => markFeatureVerified(k));
  showToast('All 6 features verified successfully!');
}

// ==========================================
// 9. MODALS, SETTINGS & ONBOARDING
// ==========================================

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

function copyShareLink() {
  const input = document.getElementById('share-url-input');
  if (input) {
    navigator.clipboard?.writeText(input.value);
    const btn = document.getElementById('copy-btn-text');
    if (btn) btn.innerText = 'Copied!';
    setTimeout(() => { if (btn) btn.innerText = 'Copy Link'; }, 2000);
    showToast('Encrypted room link copied to clipboard');
    markFeatureVerified('share');
  }
}

function panicRevokeKey() {
  const randomHex = Math.random().toString(16).substring(2, 10).toUpperCase();
  document.getElementById('key-fingerprint-text').innerText = `0x${randomHex}...REVOKED`;
  document.getElementById('share-url-input').value = `https://collab.mesh/#room=rga-9022&k=BURNED-${randomHex}`;
  showToast('Cryptographic session key burned and revoked');
}

function switchSettingsTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  const content = document.getElementById(tabId);
  if (content) content.classList.add('active');

  const btn = document.getElementById(`btn-${tabId}`);
  if (btn) btn.classList.add('active');
}

function updateFontSize(val) {
  const editor = document.getElementById('editor-surface');
  if (editor) editor.style.fontSize = `${val}px`;
  const valLabel = document.getElementById('font-size-val');
  if (valLabel) valLabel.innerText = `${val}px`;
}

function toggleLineNumbers(show) {
  const gutter = document.querySelector('.editor-gutters');
  if (gutter) gutter.style.display = show ? 'block' : 'none';
  showToast(show ? 'Line numbers visible' : 'Line numbers hidden');
}

function toggleVimMode(enabled) {
  showToast(enabled ? 'Vim modal keybindings enabled' : 'Default keybindings enabled');
}

// Onboarding Walkthrough
let currentOnboardStep = 1;
function nextOnboardStep() {
  currentOnboardStep++;
  if (currentOnboardStep > 3) {
    closeModal('onboarding-modal');
    currentOnboardStep = 1;
    switchView('editor');
    showToast('Welcome to Collab-Editor Workspace!');
    return;
  }

  document.querySelectorAll('.onboard-step').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.step-dot').forEach(el => el.classList.remove('active'));

  const stepEl = document.getElementById(`step-${currentOnboardStep}`);
  const dotEl = document.getElementById(`dot-${currentOnboardStep}`);
  if (stepEl) stepEl.classList.add('active');
  if (dotEl) dotEl.classList.add('active');

  const titles = [
    '1. Zero-Knowledge Isolation',
    '2. Offline-First CRDT',
    '3. Direct WebRTC Mesh'
  ];
  document.getElementById('onboard-step-title').innerText = titles[currentOnboardStep - 1];

  const nextBtn = document.getElementById('onboard-next-btn');
  if (currentOnboardStep === 3) {
    nextBtn.innerText = 'Launch Workspace →';
  } else {
    nextBtn.innerText = 'Continue →';
  }
}

// ==========================================
// 10. INITIALIZATION
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
  renderDocuments();
  updateLineNumbers();
  updateEditorMetrics();
});
