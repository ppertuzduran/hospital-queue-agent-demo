/**
 * patient_queue.js
 * Patient-facing queue page logic.
 * - Loads queue status and renders the patient queue table.
 * - Initialises the chatbot widget inside the floating panel.
 * Follows project3 fetch/error-handling patterns.
 */

/* ──────────────────────────────────────────────
   Session ID (persisted in sessionStorage)
────────────────────────────────────────────── */
let SESSION_ID = sessionStorage.getItem('queue_session_id');
if (!SESSION_ID) {
    SESSION_ID = 'sess_' + Math.random().toString(36).slice(2, 11);
    sessionStorage.setItem('queue_session_id', SESSION_ID);
}

/* ──────────────────────────────────────────────
   State
────────────────────────────────────────────── */
let chatInitialised = false;
let myTurn = null;          // turn number assigned to this browser session
let pollInterval = null;

/* ──────────────────────────────────────────────
   Helpers
────────────────────────────────────────────── */
async function apiFetch(url, opts = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || res.statusText);
    }
    return res.json();
}

function minutesWaiting(arrivalIso) {
    if (!arrivalIso) return '—';
    const diff = Math.floor((Date.now() - new Date(arrivalIso).getTime()) / 60000);
    return diff < 1 ? '<1 min' : `${diff} min`;
}

function statusBadge(status) {
    const map = {
        'Esperando': '<span class="badge badge-esperando">Esperando</span>',
        'Llamado': '<span class="badge badge-llamado">Llamado</span>',
        'Atendido': '<span class="badge badge-atendido">Atendido</span>',
    };
    return map[status] || `<span class="badge bg-secondary">${status}</span>`;
}

/* ──────────────────────────────────────────────
   Queue status (top cards)
────────────────────────────────────────────── */
async function loadQueueStatus() {
    try {
        const data = await apiFetch('/api/queue/status');
        document.getElementById('currentServingDisplay').textContent = data.current_serving ?? '—';

        if (myTurn !== null) {
            // If the queue was reset, next_turn_number will be <= myTurn → turn no longer exists
            if (data.next_turn_number <= myTurn) {
                myTurn = null;
                sessionStorage.removeItem('myTurn');
                document.getElementById('myTurnDisplay').textContent = '—';
                document.getElementById('myWaitDisplay').textContent = 'Obtén tu turno con el asistente';
                return;
            }

            document.getElementById('myTurnDisplay').textContent = myTurn;
            const turnsAhead = Math.max(0, myTurn - data.current_serving - 1);
            const waitMin = turnsAhead * 5;
            document.getElementById('myWaitDisplay').textContent =
                turnsAhead === 0
                    ? '¡Tu turno está próximo!'
                    : `~${waitMin} min de espera (${turnsAhead} antes)`;
        }
    } catch (e) {
        console.error('Error loading queue status:', e);
    }
}



/* ──────────────────────────────────────────────
   Chatbot widget
────────────────────────────────────────────── */
function buildChatUI() {
    const container = document.getElementById('patientChatBody');
    if (!container) return;

    container.innerHTML = `
        <div class="queue-chat-root">
            <div class="queue-chat-messages" id="chatMessages">
                <div class="text-center py-4 text-muted" id="chatEmpty">
                    <i class="bi bi-chat-dots" style="font-size:2rem;"></i>
                    <p class="mt-2 small">El asistente te guiará para obtener tu número de turno.</p>
                    <button class="btn btn-primary btn-sm" id="btnStartChat">Comenzar</button>
                </div>
            </div>
            <div class="queue-chat-input" id="chatInputRow" style="display:none;">
                <input type="text" class="form-control form-control-sm" id="chatInput"
                       placeholder="Escribe aquí…" autocomplete="off">
                <button class="btn btn-primary btn-sm" id="btnChatSend">
                    <i class="bi bi-send-fill"></i>
                </button>
            </div>
        </div>
    `;

    document.getElementById('btnStartChat').addEventListener('click', startChat);
    document.getElementById('btnChatSend').addEventListener('click', sendChatMessage);
    document.getElementById('chatInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') sendChatMessage();
    });
}

function startChat() {
    document.getElementById('chatEmpty').style.display = 'none';
    document.getElementById('chatInputRow').style.display = 'flex';
    appendMessage('assistant',
        '¡Hola! 👋 Soy el asistente de la cola del hospital.\n\n' +
        'Para obtener tu número de turno, por favor ingresa tu **DNI o carnet de identidad** (solo números).'
    );
    document.getElementById('chatInput').focus();
}

function appendMessage(role, text) {
    const messages = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `chat-msg`;

    const isUser = role === 'user';
    const rowClass = isUser ? 'chat-msg-row-user' : 'chat-msg-row-assistant';
    const bubbleClass = isUser ? 'chat-bubble-user' : 'chat-bubble-assistant';

    // Convert **bold** markdown to <strong>
    const html = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    div.innerHTML = `
        <div class="${rowClass}">
            <div class="chat-bubble ${bubbleClass}">${html}</div>
        </div>
    `;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function appendTyping() {
    const messages = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.id = 'typingIndicator';
    div.className = 'chat-msg';
    div.innerHTML = `
        <div class="chat-msg-row-assistant">
            <div class="chat-bubble chat-bubble-assistant" style="padding:0.5rem 0.75rem;">
                <div class="typing-indicator">
                    <span></span><span></span><span></span>
                </div>
            </div>
        </div>
    `;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function removeTyping() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const msg = input.value.trim();
    if (!msg) return;

    input.value = '';
    appendMessage('user', msg);
    appendTyping();

    // Disable input while waiting
    input.disabled = true;
    document.getElementById('btnChatSend').disabled = true;

    try {
        const data = await apiFetch('/api/patient/chat', {
            method: 'POST',
            body: JSON.stringify({ session_id: SESSION_ID, message: msg }),
        });

        removeTyping();
        appendMessage('assistant', data.reply || 'Sin respuesta.');

        // If turn was assigned, update the page
        if (data.reply && data.reply.includes('turno es')) {
            // Extract turn number from reply (pattern: "turno es **NN**")
            const match = data.reply.match(/turno es \*\*(\d+)\*\*/);
            if (match) {
                myTurn = parseInt(match[1], 10);
                sessionStorage.setItem('myTurn', myTurn);
                loadQueueStatus();
            }
        }
    } catch (e) {
        removeTyping();
        appendMessage('assistant', 'Lo siento, ocurrió un error. Por favor intenta nuevamente.');
        console.error('Chat error:', e);
    } finally {
        input.disabled = false;
        document.getElementById('btnChatSend').disabled = false;
        input.focus();
    }
}

/* ──────────────────────────────────────────────
   initPatientChat — called by base.html when panel opens
────────────────────────────────────────────── */
function initPatientChat() {
    if (chatInitialised) return;
    chatInitialised = true;
    buildChatUI();
}

/* ──────────────────────────────────────────────
   Auto-poll
────────────────────────────────────────────── */
function startPolling() {
    loadQueueStatus();
    pollInterval = setInterval(() => {
        loadQueueStatus();
    }, 5000);
}

/* ──────────────────────────────────────────────
   Init
────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    // Restore myTurn from session storage if previously assigned
    const saved = sessionStorage.getItem('myTurn');
    if (saved) myTurn = parseInt(saved, 10);

    startPolling();
});
