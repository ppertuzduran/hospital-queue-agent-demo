/**
 * manager_agent.js — Queue Manager Agent
 * Provides statistical analysis of queue data with chart generation.
 * Follows the same patterns as project3's manager_agent.js:
 *   - OpenAI for natural-language responses (if API key available)
 *   - CHART:wait tool triggers the wait-by-appointment-type chart
 *   - Keyword fallback so the chart works even without an API key
 */

let conversationHistory = [];
let queueData = [];

// ──────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await loadApiKeyFromServer();

    const saved = localStorage.getItem('openai_api_key');
    if (saved) document.getElementById('apiKeyInput').value = saved;

    document.getElementById('btnStartChat').addEventListener('click', startChat);
    document.getElementById('btnSend').addEventListener('click', sendMessage);
    document.getElementById('messageInput').addEventListener('keypress', e => {
        if (e.key === 'Enter') sendMessage();
    });
    document.getElementById('btnSaveApiKey').addEventListener('click', saveApiKey);

    await loadQueueData();
});

async function loadApiKeyFromServer() {
    try {
        const res = await fetch('/api/config');
        const cfg = await res.json();
        if (cfg.api_key) {
            localStorage.setItem('openai_api_key', cfg.api_key);
        }
    } catch (_) { }
}

async function loadQueueData() {
    try {
        const res = await fetch('/api/manager/queue');
        queueData = await res.json();
    } catch (_) {
        queueData = [];
    }
}

// ──────────────────────────────────────────────
// Chat flow
// ──────────────────────────────────────────────
function startChat() {
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('chatInputContainer').style.display = 'block';

    const served = queueData.filter(r => r.status === 'Atendido').length;
    const waiting = queueData.filter(r => r.status === 'Esperando').length;

    const welcome = `¡Hola! 👋 Soy el **Manager Agent** de Gestión de Colas.

Tengo acceso a los datos en tiempo real de la cola del hospital. Actualmente hay **${waiting} paciente(s) esperando** y **${served} atendido(s) hoy**.

📊 **Herramientas disponibles:**
1. **Promedio de espera por tipo de cita** — gráfico de barras con los tiempos promedio para Radiología, Laboratorio e Ingreso.
2. **Resumen de métricas** — estadísticas generales de la cola.

💡 **Ejemplos de preguntas:**
- Muestra el promedio de espera por tipo de cita
- ¿Cuántos pacientes están esperando?
- Dame un resumen de la cola
- ¿Cuál es el tipo de cita con mayor espera?

¿En qué puedo ayudarte? 😊`;

    addMessage('assistant', welcome);
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const msg = input.value.trim();
    if (!msg) return;

    addMessage('user', msg);
    input.value = '';
    showTyping();

    // Reload queue data for fresh metrics
    await loadQueueData();

    const reply = await processMessage(msg);
    hideTyping();
    addMessage('assistant', reply);
}

// ──────────────────────────────────────────────
// Message processing
// ──────────────────────────────────────────────
async function processMessage(userMsg) {
    const apiKey = localStorage.getItem('openai_api_key');

    if (!apiKey) {
        // No API key: use keyword-only fallback
        return await keywordFallback(userMsg);
    }

    try {
        const metrics = await fetchMetrics();
        const context = buildContext(userMsg, metrics);

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: context,
                temperature: 0.6,
                max_tokens: 1000,
            }),
        });

        if (!res.ok) throw new Error(`API ${res.status}`);

        const data = await res.json();
        let reply = data.choices[0].message.content;

        conversationHistory.push({ role: 'user', content: userMsg });
        conversationHistory.push({ role: 'assistant', content: reply });

        // Process tool calls embedded in the reply
        reply = await processTools(userMsg, reply);
        return reply;

    } catch (err) {
        console.error('OpenAI error:', err);
        // Graceful fallback on API errors
        return await keywordFallback(userMsg);
    }
}

async function keywordFallback(userMsg) {
    const norm = userMsg.toLowerCase();

    if (anyKeyword(norm, ['espera', 'promedio', 'tiempo', 'minutos', 'tipo', 'cita', 'gráfico', 'grafico', 'chart', 'muestra', 'visualiza'])) {
        const chartHTML = await generateWaitChart();
        return `Aquí está el **promedio de espera por tipo de cita**:\n\n${chartHTML}`;
    }

    if (anyKeyword(norm, ['cuántos', 'cuantos', 'esperando', 'cola', 'resumen', 'estado', 'métricas', 'metricas'])) {
        const metrics = await fetchMetrics();
        return buildMetricsSummary(metrics);
    }

    // Generic help
    return `Puedo mostrarte estadísticas de la cola. Prueba:\n- **"Muestra el promedio de espera por tipo de cita"**\n- **"Dame un resumen de la cola"**`;
}

function anyKeyword(text, keywords) {
    return keywords.some(k => text.includes(k));
}

// ──────────────────────────────────────────────
// OpenAI context builder
// ──────────────────────────────────────────────
function buildContext(userMsg, metrics) {
    const system = `Eres el Manager Agent de Gestión de Colas del hospital.
Analizas datos de la cola en tiempo real y proporcionas insights estadísticos.

DATOS ACTUALES DE LA COLA:
- Atendiendo ahora: N° ${metrics.current_serving}
- Pacientes esperando: ${metrics.waiting_count}
- Llamados (en atención): ${metrics.called_count}
- Atendidos hoy: ${metrics.served_today}
- Promedio de espera hoy: ${metrics.avg_wait_minutes !== null ? metrics.avg_wait_minutes + ' min' : 'Sin datos suficientes'}

HERRAMIENTA DISPONIBLE:
Incluye exactamente **CHART:wait** en tu respuesta cuando el usuario pida:
- Promedio/tiempo de espera por tipo de cita
- Gráfico/visualización de esperas
- Comparación entre tipos de cita

INSTRUCCIONES:
- Responde siempre en español de forma profesional y orientada a la gestión hospitalaria.
- Usa datos concretos cuando los tengas.
- Cuando uses la herramienta, menciona que vas a mostrar el gráfico.
- Sé conciso pero informativo.`;

    const messages = [{ role: 'system', content: system }];
    messages.push(...conversationHistory.slice(-6));
    messages.push({ role: 'user', content: userMsg });
    return messages;
}

// ──────────────────────────────────────────────
// Tool processor (same pattern as project3)
// ──────────────────────────────────────────────
async function processTools(userMsg, reply) {
    let result = reply;
    const norm = userMsg.toLowerCase();

    // Explicit tool call from LLM
    if (result.includes('CHART:wait')) {
        const chartHTML = await generateWaitChart();
        result = result.replace(/CHART:wait/gi, '').trim();
        result += '\n\n' + chartHTML;
        return result;
    }

    // Keyword fallback: trigger chart even if LLM forgot the tag
    const chartKeywords = ['promedio', 'espera', 'tipo de cita', 'gráfico', 'grafico', 'chart', 'visualiza'];
    if (anyKeyword(norm, chartKeywords) && !result.includes('chart-container')) {
        const chartHTML = await generateWaitChart();
        result += '\n\n' + chartHTML;
    }

    return result;
}

// ──────────────────────────────────────────────
// Chart generator
// ──────────────────────────────────────────────
async function generateWaitChart() {
    try {
        const res = await fetch('/api/charts/wait-by-appointment-type');
        if (!res.ok) throw new Error('Chart endpoint error');
        const data = await res.json();
        const s = data.stats;

        const simNote = s.is_simulated
            ? '<div class="alert alert-info py-1 px-2 small mt-2 mb-0"><i class="bi bi-info-circle me-1"></i>Datos simulados (no hay suficientes registros atendidos aún).</div>'
            : '';

        // Color palette for each appointment type
        const palette = ['#0d6efd', '#198754', '#fd7e14', '#6f42c1', '#dc3545', '#0dcaf0'];
        const typeEntries = Object.entries(s.averages);
        const typePills = typeEntries.map(([tipo, avg], i) => {
            const color = palette[i % palette.length];
            return `<div style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e9ecef;border-left:4px solid ${color};border-radius:8px;padding:8px 12px;"><div style="flex:1;"><div style="font-size:0.7rem;color:#6c757d;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">${tipo}</div><div style="font-size:1.1rem;font-weight:700;color:${color};line-height:1.2;">${avg}<span style="font-size:0.7rem;font-weight:500;color:#6c757d;margin-left:2px;">min</span></div></div></div>`;
        }).join('');

        const summaryRow = `<div style="display:flex;gap:8px;margin-top:8px;"><div style="flex:1;background:linear-gradient(135deg,#fff3e0,#fff8f0);border:1px solid #ffd180;border-radius:8px;padding:8px 12px;"><div style="font-size:0.68rem;color:#e65100;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">Mayor espera</div><div style="font-size:0.85rem;font-weight:600;color:#bf360c;margin-top:3px;">${s.longest_wait_type}<br><span style="font-size:1rem;font-weight:700;">${s.longest_wait_minutes} min</span></div></div><div style="flex:1;background:linear-gradient(135deg,#e8f5e9,#f1f8f2);border:1px solid #a5d6a7;border-radius:8px;padding:8px 12px;"><div style="font-size:0.68rem;color:#1b5e20;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">Menor espera</div><div style="font-size:0.85rem;font-weight:600;color:#2e7d32;margin-top:3px;">${s.shortest_wait_type}<br><span style="font-size:1rem;font-weight:700;">${s.shortest_wait_minutes} min</span></div></div></div>`;

        return `<div class="chart-container"><img src="${data.image}" alt="Promedio de espera por tipo de cita" class="expandable-chart" style="max-width:100%;max-height:220px;object-fit:contain;cursor:zoom-in;border-radius:6px;transition:opacity .15s;display:block;margin:0 auto;" title="Clic para ampliar">${simNote}<div style="display:flex;flex-direction:column;gap:8px;margin-top:12px;">${typePills}</div>${summaryRow}</div>`;
    } catch (err) {
        console.error('Chart error:', err);
        return '❌ Error al generar el gráfico. Por favor intenta nuevamente.';
    }
}

// ──────────────────────────────────────────────
// Metrics helper
// ──────────────────────────────────────────────
async function fetchMetrics() {
    try {
        const res = await fetch('/api/manager/metrics');
        return await res.json();
    } catch (_) {
        return { current_serving: '—', waiting_count: 0, called_count: 0, served_today: 0, avg_wait_minutes: null };
    }
}

function buildMetricsSummary(m) {
    const avg = m.avg_wait_minutes !== null ? `${m.avg_wait_minutes} min` : 'Sin datos suficientes';
    return `📊 **Resumen actual de la cola:**

- 🔢 **Atendiendo ahora:** N° ${m.current_serving}
- ⏳ **Esperando:** ${m.waiting_count} paciente(s)
- 📞 **En atención (llamados):** ${m.called_count}
- ✅ **Atendidos hoy:** ${m.served_today}
- ⏱️ **Promedio de espera:** ${avg}

Para ver el desglose por tipo de cita, pídeme: *"Muestra el promedio de espera por tipo de cita"*.`;
}

// ──────────────────────────────────────────────
// UI helpers
// ──────────────────────────────────────────────
function addMessage(role, content) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `chat-message message-${role}`;

    const avatar = role === 'user'
        ? '<i class="bi bi-person-fill"></i>'
        : '<i class="bi bi-bar-chart-line-fill"></i>';

    const avatarOrder = role === 'user' ? 'order-2' : 'order-1';
    const contentOrder = role === 'user' ? 'order-1' : 'order-2';

    div.innerHTML = `
        <div class="message-content">
            <div class="message-avatar ${avatarOrder}">${avatar}</div>
            <div class="message-bubble ${contentOrder}">${formatContent(content)}</div>
        </div>`;

    container.appendChild(div);

    if (role === 'assistant') {
        div.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function formatContent(text) {
    let html = text.replace(/\n/g, '<br>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
    // Raw HTML (chart containers) passes through unchanged
    return html;
}

function showTyping() {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.id = 'typingIndicator';
    div.className = 'chat-message message-assistant';
    div.innerHTML = `
        <div class="message-content">
            <div class="message-avatar"><i class="bi bi-bar-chart-line-fill"></i></div>
            <div class="message-bubble">
                <div class="typing-indicator">
                    <span></span><span></span><span></span>
                </div>
            </div>
        </div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function hideTyping() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
}

function saveApiKey() {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (!key) return;
    localStorage.setItem('openai_api_key', key);
    bootstrap.Modal.getInstance(document.getElementById('settingsModal')).hide();
}
