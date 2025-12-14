// Globala variabler för API
let API_KEY = null;
const API_URL = 'http://localhost:3001/search_all';

// === DOM-ELEMENT (CHATT) ===
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const chatMessages = document.getElementById('chat-messages');
const appNameDisplay = document.getElementById('app-name-display');

// === DOM-ELEMENT (VY-VÄXLING) ===
const menuItems = document.querySelectorAll('.sidebar-menu .menu-item');
const views = document.querySelectorAll('.chat-view, .templates-view, .settings-view');

// === DOM-ELEMENT (MALLAR) ===
const templateList = document.getElementById('template-list');
const editorView = document.getElementById('template-editor-form');
const editorPlaceholder = document.getElementById('editor-placeholder');
const newTemplateBtn = document.getElementById('new-template-btn');
const deleteTemplateBtn = document.getElementById('delete-template-btn');
const templateForm = document.getElementById('template-editor-form');
const templateIdInput = document.getElementById('template-id-input');
const templateTitleInput = document.getElementById('template-title-input');
const templateGroupInput = document.getElementById('template-group-input');
const templateContentInput = document.getElementById('template-content-input');
const templateSaveBtn = templateForm ? templateForm.querySelector('.save-button') : null;

// === DOM-ELEMENT (INKORG) ===
const inboxList = document.getElementById('inbox-list');
const inboxPlaceholder = document.getElementById('inbox-placeholder');
const inboxDetail = document.getElementById('inbox-detail');
const inboxQuestion = document.getElementById('inbox-question');
const inboxAnswer = document.getElementById('inbox-answer');
const copyAnswerBtn = document.getElementById('copy-answer-btn');
const deleteQABtn = document.getElementById('delete-qa-btn');
const clearInboxBtn = document.getElementById('clear-inbox-btn');

// === DOM-ELEMENT (OM-SIDAN) ===
const appVersionDisplay = document.getElementById('app-version-display');
const serverVersionDisplay = document.getElementById('server-version-display');

window.currentServerSessionId = null;

// ============================================
// ✅ ATLAS MEMORY SYSTEM
// ============================================

let currentSession = null;
let sessionHistory = [];

class ChatSession {
  constructor() {
    this.id = `session_${Date.now()}`;
    this.messages = [];
    this.startTime = new Date();
    this.context = '';
    this.linksSentByVehicle = {};
    this.isFirstUserMessage = true;
    this.detectedCity = null;
    this.detectedArea = null;
    this.detectedVehicleType = null;
    this.contextLocked = false;
  }

  updateContext(city, area, vehicle) {
    if (city) {
      this.detectedCity = city;
      console.log(`[SESSION] Låste stad: ${city}`);
    }
    if (area) {
      this.detectedArea = area;
      console.log(`[SESSION] Låste område: ${area}`);
    }
    if (vehicle) {
      this.detectedVehicleType = vehicle;
      console.log(`[SESSION] Låste fordonstyp: ${vehicle}`);
    }
    if (this.detectedCity && this.detectedVehicleType) {
      this.contextLocked = true;
      console.log(`[SESSION] ✅ Kontext FULLSTÄNDIGT låst: ${this.detectedCity} + ${this.detectedVehicleType}`);
    }
  }

  addMessage(role, text) {
    this.messages.push({ role, text, timestamp: new Date() });
  }

  getFullContext() {
    return this.messages
      .map(m => `${m.role === 'user' ? 'Användare' : 'Atlas'}: ${m.text}`)
      .join('\n\n');
  }

  getLastNMessages(n = 5) {
    return this.messages.slice(-n);
  }
}

function startNewSession() {
  if (currentSession && currentSession.messages.length > 0) {
    saveSessionToInbox(currentSession);
  }
  currentSession = new ChatSession();
  sessionHistory.push(currentSession);
  chatMessages.innerHTML = '';
  console.log(`✅ Ny session startad: ${currentSession.id}`);
}

function saveSessionToInbox(session) {
  if (session.messages.length === 0) return;
  const firstUserMsg = session.messages.find(m => m.role === 'user');
  const lastAtlasMsg = [...session.messages].reverse().find(m => m.role === 'atlas');
  if (firstUserMsg && lastAtlasMsg) {
    const qa = {
      id: `qa_${Date.now()}`,
      question: firstUserMsg.text,
      answer: session.getFullContext(),
      timestamp: session.startTime.toISOString(),
      sessionId: session.id
    };
    allQA.push(qa);
    if (allQA.length > 50) allQA = allQA.slice(-50);
    saveQAToStorage();
    console.log(`✅ Session sparad till inkorgen: ${session.id}`);
  }
}

function handleViewChange(newViewId) {
  if (newViewId !== 'chat') {
    if (currentSession && currentSession.messages.length > 0) {
      console.log('💾 Sparar session innan man lämnar HEM-tabben...');
      saveSessionToInbox(currentSession);
    }
  }
}

// === QUILL RICH TEXT EDITOR ===
let quill = null;

// === LOKAL DATABAS FÖR MALLAR & QA ===
let allTemplates = [];
let allQA = [];
let currentEditingId = null;
let currentViewingQAId = null;

// SVG Ikoner
const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="green" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

function parseMarkdownLinks(text) {
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  return text.replace(markdownLinkRegex, (match, linkText, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="atlas-link">${linkText}</a>`;
  });
}

function switchView(viewId) {
  views.forEach(view => view.style.display = 'none');
  const viewToShow = document.getElementById(`view-${viewId}`);
  if (viewToShow) viewToShow.style.display = 'flex';
  menuItems.forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-view') === viewId);
  });
  handleViewChange(viewId);
  if (viewId === 'inbox') renderInboxList();
}

function setSaveButtonActive(isActive) {
  if (!templateSaveBtn) return;
  templateSaveBtn.classList.toggle('active', isActive);
  templateSaveBtn.disabled = !isActive;
}

async function loadAndRenderTemplates() {
  try {
    const templates = await window.electronAPI.loadTemplates();
    if (!templates || templates.length === 0) {
      templateList.innerHTML = '<div class="template-item-empty">Du har inga mallar än.</div>';
      return;
    }
    templates.sort((a, b) => a.title.localeCompare(b.title));
    allTemplates = templates;
    templateList.innerHTML = '';

    const groups = {};
    allTemplates.forEach(t => {
      const group = t.group || 'Övrigt';
      if (!groups[group]) groups[group] = [];
      groups[group].push(t);
    });

    Object.keys(groups).sort().forEach(groupName => {
      const header = document.createElement('div');
      header.className = 'template-group-header';
      header.innerHTML = `
        <div class="group-header-content">
          <span class="group-arrow">▶</span>
          <span class="group-name">${groupName}</span>
        </div>
        <span class="group-count">${groups[groupName].length}</span>
      `;

      const content = document.createElement('div');
      content.className = 'template-group-content';

      groups[groupName].sort((a, b) => a.title.localeCompare(b.title)).forEach(template => {
        const item = document.createElement('div');
        item.classList.add('template-item');
        item.setAttribute('data-id', template.id);

        const titleSpan = document.createElement('span');
        titleSpan.textContent = template.title;
        titleSpan.className = 'template-title';
        item.appendChild(titleSpan);

        const copyBtn = document.createElement('button');
        copyBtn.innerHTML = COPY_ICON;
        copyBtn.classList.add('template-copy-btn');
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = template.content;
          const plainText = tempDiv.textContent || tempDiv.innerText || '';
          window.electronAPI.copyToClipboard(plainText);
          copyBtn.innerHTML = CHECK_ICON;
          setTimeout(() => copyBtn.innerHTML = COPY_ICON, 1500);
        });
        item.appendChild(copyBtn);

        item.addEventListener('click', (e) => {
          if (!e.target.classList.contains('template-copy-btn')) {
            openTemplateInEditor(template.id);
          }
        });
        content.appendChild(item);
      });

      header.addEventListener('click', () => {
        const isExpanded = content.classList.contains('expanded');
        const arrow = header.querySelector('.group-arrow');
        if (isExpanded) {
          content.classList.remove('expanded');
          arrow.textContent = '▶';
          arrow.classList.remove('expanded');
        } else {
          content.classList.add('expanded');
          arrow.textContent = '▼';
          arrow.classList.add('expanded');
        }
      });

      templateList.appendChild(header);
      templateList.appendChild(content);
    });
  } catch (err) {
    console.error('Fel vid laddning av mallar:', err);
    templateList.innerHTML = '<div class="template-item-empty">Kunde inte ladda mallar – starta om appen.</div>';
  }
}

function openTemplateInEditor(id) {
  const template = allTemplates.find(t => t.id === id);
  if (!template) return;
  currentEditingId = id;
  templateIdInput.value = template.id;
  templateTitleInput.value = template.title;
  templateGroupInput.value = template.group || '';
  let content = template.content || '';
  if (content.includes('\n') && !content.includes('<p>') && !content.includes('<br>')) {
    content = content.split('\n').map(line => line.trim() ? `<p>${line}</p>` : '<p><br></p>').join('');
  }
  if (quill) quill.root.innerHTML = content;
  editorPlaceholder.style.display = 'none';
  editorView.style.display = 'flex';
  deleteTemplateBtn.style.display = 'block';
  document.querySelectorAll('.template-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-id') === id);
  });
  setSaveButtonActive(false);
}

function showNewTemplateEditor() {
  currentEditingId = null;
  templateIdInput.value = '';
  templateTitleInput.value = '';
  templateGroupInput.value = '';
  if (quill) quill.root.innerHTML = '';
  editorPlaceholder.style.display = 'none';
  editorView.style.display = 'flex';
  deleteTemplateBtn.style.display = 'none';
  document.querySelectorAll('.template-item').forEach(item => item.classList.remove('active'));
  setSaveButtonActive(true);
}

async function saveTemplate(e) {
  if (e) e.preventDefault();
  const title = templateTitleInput.value.trim();
  const group = templateGroupInput.value.trim();
  const content = quill ? quill.root.innerHTML : '';
  if (!title || !content || content === '<p><br></p>') {
    alert('Du måste fylla i både titel och innehåll.');
    return;
  }
  let savedTemplateId = currentEditingId;
  if (currentEditingId) {
    const index = allTemplates.findIndex(t => t.id === currentEditingId);
    if (index > -1) {
      allTemplates[index].title = title;
      allTemplates[index].content = content;
      allTemplates[index].group = group || 'Övrigt';
    }
  } else {
    const newTemplate = {
      id: `template_${Date.now()}`,
      title,
      content,
      group: group || 'Övrigt'
    };
    allTemplates.push(newTemplate);
    savedTemplateId = newTemplate.id;
  }
  const result = await window.electronAPI.saveTemplates(allTemplates);
  if (result.success) {
    await loadAndRenderTemplates();
    openTemplateInEditor(savedTemplateId);
    setSaveButtonActive(false);
  } else {
    alert(`Kunde inte spara mallen: ${result.error}`);
  }
}

async function deleteTemplate() {
  if (!currentEditingId) return;
  if (!confirm('Är du säker på att du vill ta bort denna mall permanent?')) return;
  allTemplates = allTemplates.filter(t => t.id !== currentEditingId);
  const result = await window.electronAPI.saveTemplates(allTemplates);
  if (result.success) {
    await loadAndRenderTemplates();
    editorView.style.display = 'none';
    editorPlaceholder.style.display = 'block';
    currentEditingId = null;
  } else {
    alert(`Kunde inte ta bort mallen: ${result.error}`);
  }
}

function loadQAFromStorage() {
  const stored = localStorage.getItem('atlas_qa_history');
  if (stored) {
    try {
      allQA = JSON.parse(stored);
      if (allQA.length > 50) {
        allQA = allQA.slice(-50);
        saveQAToStorage();
      }
    } catch (e) {
      console.error('Fel vid läsning av QA-historik:', e);
      allQA = [];
    }
  }
}

function saveQAToStorage() {
  try {
    localStorage.setItem('atlas_qa_history', JSON.stringify(allQA));
  } catch (e) {
    console.error('Fel vid sparning av QA-historik:', e);
  }
}

function renderInboxList() {
  if (!allQA || allQA.length === 0) {
    inboxList.innerHTML = '<div class="template-item-empty">Inga frågor än. Ställ en fråga i Hem-vyn!</div>';
    return;
  }
  inboxList.innerHTML = '';
  const sortedQA = [...allQA].reverse();
  sortedQA.forEach(qa => {
    const item = document.createElement('div');
    item.classList.add('template-item');
    item.setAttribute('data-id', qa.id);
    const shortQuestion = qa.question.length > 60 ? qa.question.substring(0, 60) + '...' : qa.question;
    const titleSpan = document.createElement('span');
    titleSpan.textContent = shortQuestion;
    titleSpan.className = 'template-title';
    item.appendChild(titleSpan);
    const dateSpan = document.createElement('span');
    dateSpan.style.fontSize = '11px';
    dateSpan.style.color = 'var(--text-secondary)';
    dateSpan.style.marginTop = '4px';
    const date = new Date(qa.timestamp);
    dateSpan.textContent = date.toLocaleDateString('sv-SE') + ' ' + date.toLocaleTimeString('sv-SE', {hour: '2-digit', minute: '2-digit'});
    item.appendChild(dateSpan);
    item.addEventListener('click', () => openQADetail(qa.id));
    inboxList.appendChild(item);
  });
}

function openQADetail(qaId) {
  const qa = allQA.find(q => q.id === qaId);
  if (!qa) return;
  currentViewingQAId = qaId;
  inboxQuestion.textContent = qa.question;
  inboxAnswer.textContent = qa.answer;
  inboxPlaceholder.style.display = 'none';
  inboxDetail.style.display = 'flex';
  document.querySelectorAll('#inbox-list .template-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-id') === qaId);
  });
}

function deleteCurrentQA() {
  if (!currentViewingQAId) return;
  if (!confirm('Är du säker på att du vill ta bort denna fråga och svar?')) return;
  allQA = allQA.filter(qa => qa.id !== currentViewingQAId);
  saveQAToStorage();
  inboxDetail.style.display = 'none';
  inboxPlaceholder.style.display = 'flex';
  currentViewingQAId = null;
  renderInboxList();
}

function clearAllInbox() {
  if (!confirm('Är du säker på att du vill rensa HELA inkorgen? Detta kan inte ångras.')) return;
  allQA = [];
  saveQAToStorage();
  inboxDetail.style.display = 'none';
  inboxPlaceholder.style.display = 'flex';
  currentViewingQAId = null;
  renderInboxList();
}

// ✅ FIXAD - console.log flyttad INUTI fetch
async function sendQueryToServerWithMemory(query) {
  if (!API_KEY) {
    console.error('API-nyckel saknas!');
    addMessageToUI('Ett klientfel uppstod (API-nyckel saknas). Starta om appen.', 'atlas');
    return;
  }

  if (!currentSession) startNewSession();
  currentSession.addMessage('user', query);
  addMessageToUI(query, 'user');
  messageInput.value = '';

  try {
    const sessionContext = currentSession.getLastNMessages(10);
    
    console.log('[FRONTEND] Skickar sessionId:', window.currentServerSessionId); // ✅ FLYTTAD HIT

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify({
        query,
        sessionContext,
        sessionId: window.currentServerSessionId || null,
        isFirstMessage: currentSession.isFirstUserMessage,
        savedCity: currentSession.detectedCity,
        savedArea: currentSession.detectedArea,
        savedVehicle: currentSession.detectedVehicleType
      })
    });

    if (!response.ok) throw new Error(`Serverfel: ${response.statusText}`);
    const data = await response.json();

    if (data && data.sessionId) {
      window.currentServerSessionId = data.sessionId;
      console.log('[FRONTEND] Sparade server-sessionId =', window.currentServerSessionId);
    }

    const answer = data.answer || 'Jag kunde inte hitta ett svar.';

    currentSession.detectedCity = data.locked_context?.city || null;
    currentSession.detectedArea = data.locked_context?.area || null;
    currentSession.detectedVehicleType = data.locked_context?.vehicle || null;

    console.log('[SESSION] Uppdaterad från server:', {
      city: currentSession.detectedCity,
      area: currentSession.detectedArea,
      vehicle: currentSession.detectedVehicleType
    });

    currentSession.addMessage('atlas', answer);
    addMessageToUI(answer, 'atlas');

    if (currentSession.isFirstUserMessage) {
      currentSession.isFirstUserMessage = false;
      console.log('[SESSION] Första användarfrågan besvarad');
    }

    if (answer.includes('Boka din') || answer.includes('hemsida') || answer.includes('---')) {
      console.log('[SESSION] Bokningslänk skickad');
    }

    window.electronAPI.copyToClipboard(answer);

  } catch (error) {
    console.error('Fel vid fetch:', error);
    addMessageToUI(`Ett fel uppstod: ${error.message}`, 'atlas');
  }
}

async function clearServerSession() {
  if (!window.currentServerSessionId) return;
  console.log(`[FRONTEND] Rensar session ${window.currentServerSessionId} på servern.`);
  await fetch(API_URL.replace('/search_all', '/clear_session'), { 
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY
    },
    body: JSON.stringify({ sessionId: window.currentServerSessionId })
  });
  window.currentServerSessionId = null;
}

function addMessageToUI(text, who = 'atlas') {
  const wrapper = document.createElement('div');
  wrapper.className = 'message ' + (who === 'user' ? 'user' : 'atlas');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (who === 'atlas') {
    let formatted = text
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>');
    bubble.innerHTML = parseMarkdownLinks(formatted);
  } else {
    bubble.textContent = text;
  }
  wrapper.appendChild(bubble);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateServerStatus(connected) {
  const statusContainer = document.body;
  if (connected) {
    statusContainer.classList.add('status-connected');
    statusContainer.classList.remove('status-disconnected');
  } else {
    statusContainer.classList.add('status-disconnected');
    statusContainer.classList.remove('status-connected');
  }
}

// ✅ INITIALISERING
document.addEventListener('DOMContentLoaded', async () => {
  try {
    if (!window.electronAPI) {
      console.error('window.electronAPI finns inte! Kontrollera preload.js');
      return;
    }

    const appInfo = await window.electronAPI.getAppInfo();
    API_KEY = appInfo.CLIENT_API_KEY;
    if (appNameDisplay) appNameDisplay.textContent = appInfo.APP_NAME;
    if (appVersionDisplay) appVersionDisplay.textContent = appInfo.ATLAS_VERSION;
    if (serverVersionDisplay) serverVersionDisplay.textContent = appInfo.SERVER_VERSION;

    startNewSession();
    addMessageToUI(
      "Hej! Jag är Atlas, din körkortsguide 🚗✨<br>Fråga mig vad du vill om My Driving Academys tjänster eller frågor som rör ditt körkort.",
      "atlas"
    );

    await loadAndRenderTemplates();
    loadQAFromStorage();

    if (typeof Quill !== 'undefined') {
      quill = new Quill('#quill-editor', {
        theme: 'snow',
        modules: {
          toolbar: [
            [{ 'header': [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ 'list': 'ordered'}, { 'list': 'bullet' }],
            [{ 'color': [] }, { 'background': [] }],
            ['link', 'image'],
            ['clean']
          ]
        }
      });
      quill.on('text-change', () => setSaveButtonActive(true));
    }

    menuItems.forEach(item => item.addEventListener('click', () => switchView(item.getAttribute('data-view'))));

    // ✅ FIXAD - Chat form submit
    if (chatForm) {
      chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = messageInput.value.trim();
        if (query) sendQueryToServerWithMemory(query);
      });
    }

    // Urklipps-genvägar
    window.electronAPI.onProcessClipboard(async (text, shouldClear) => { 
      if (text && text.trim()) {
        console.log(`[Urklipp mottaget] Text: "${text.substring(0, 20)}...", Rensa session: ${shouldClear}`);

        if (shouldClear) {
          if (currentSession && currentSession.messages.length > 0) {
            saveSessionToInbox(currentSession);
          }
          await clearServerSession();
          if (currentSession) {
            currentSession.detectedCity = null;
            currentSession.detectedArea = null;
            currentSession.detectedVehicleType = null;
            currentSession.contextLocked = false;
            currentSession.linkSent = false;
            currentSession.isFirstUserMessage = true;
          }
          startNewSession();
        } else {
          if (!currentSession) startNewSession();
        }

        switchView('chat'); 
        sendQueryToServerWithMemory(text.trim()); 
      }
    });

    if (newTemplateBtn) newTemplateBtn.addEventListener('click', showNewTemplateEditor);
    if (templateForm) templateForm.addEventListener('submit', saveTemplate);
    if (deleteTemplateBtn) deleteTemplateBtn.addEventListener('click', deleteTemplate);

    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        if (document.getElementById('view-templates').style.display === 'flex' && templateSaveBtn && !templateSaveBtn.disabled) {
          saveTemplate();
        }
      }
    });

    if (templateTitleInput) templateTitleInput.addEventListener('input', () => setSaveButtonActive(true));
    if (templateGroupInput) templateGroupInput.addEventListener('input', () => setSaveButtonActive(true));

    if (copyAnswerBtn) {
      copyAnswerBtn.addEventListener('click', () => {
        const answer = inboxAnswer.textContent;
        if (answer) {
          window.electronAPI.copyToClipboard(answer);
          const orig = copyAnswerBtn.textContent;
          copyAnswerBtn.textContent = '✓ Kopierat!';
          setTimeout(() => copyAnswerBtn.textContent = orig, 1500);
        }
      });
    }

    if (deleteQABtn) deleteQABtn.addEventListener('click', deleteCurrentQA);
    if (clearInboxBtn) clearInboxBtn.addEventListener('click', clearAllInbox);

    // Tema-hantering
    const themeSelect = document.getElementById('theme-select');
    const themeStylesheet = document.getElementById('theme-stylesheet');
    const savedTheme = localStorage.getItem('atlas-theme') || 'chrome-light';
    if (themeSelect) themeSelect.value = savedTheme;
    if (themeStylesheet) themeStylesheet.href = `./assets/themes/${savedTheme}/${savedTheme}.css`;
    
    if (themeSelect) {
      themeSelect.addEventListener('change', e => {
        const selected = e.target.value;
        themeStylesheet.href = `./assets/themes/${selected}/${selected}.css`;
        localStorage.setItem('atlas-theme', selected);
      });
    }

    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.altKey && e.key === 't') {
        e.preventDefault();
        if (themeSelect) {
          const next = (themeSelect.selectedIndex + 1) % themeSelect.options.length;
          themeSelect.selectedIndex = next;
          themeSelect.dispatchEvent(new Event('change'));
        }
      }
    });

	// Ny Chatt-knapp (Header)
    const newChatBtnHeader = document.getElementById('new-chat-btn-header');
    if (newChatBtnHeader) {
      newChatBtnHeader.addEventListener('click', async () => {
        if (confirm('Vill du starta en ny chatt? Den nuvarande konversationen sparas i Inkorgen.')) {
          if (currentSession && currentSession.messages.length > 0) {
            saveSessionToInbox(currentSession);
          }
          await clearServerSession();
          window.currentServerSessionId = null;
          if (currentSession) {
            currentSession.detectedCity = null;
            currentSession.detectedArea = null;
            currentSession.detectedVehicleType = null;
            currentSession.contextLocked = false;
            currentSession.linkSent = false;
            currentSession.isFirstUserMessage = true;
          }
          startNewSession();
          addMessageToUI(
            `Hej! Jag är Atlas, din körkortsguide 🚗✨\nFråga mig vad du vill om My Driving Academys tjänster eller frågor som rör ditt körkort.`,
            "atlas"
          );
          console.log('[NY CHATT] Startad via header-knapp.');
        }
      });
    }

    updateServerStatus(true);
    setTimeout(async () => {
      try {
        const check = await fetch('http://localhost:3001/');
        if (!check.ok) throw new Error('Server svarar inte');
        updateServerStatus(true);
      } catch (error) {
        console.error('Servern är offline efter start:', error);
        updateServerStatus(false);
      }
    }, 5000);

  } catch (error) {
    console.error('Fel vid initialisering:', error);
  }
});