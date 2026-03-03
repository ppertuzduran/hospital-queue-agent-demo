/**
 * manager_queue.js
 * Manager dashboard logic:
 * - Renders queue table with call / serve / reorder actions.
 * - Polls metrics every 5 seconds.
 * - Uses same fetch patterns as project3.
 */

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

/** For Atendido: compute exact recorded wait (served_time − arrival_time). */
function minutesActualWait(arrivalIso, servedIso) {
    if (!arrivalIso || !servedIso) return '—';
    const diff = Math.floor((new Date(servedIso) - new Date(arrivalIso)) / 60000);
    return diff < 1 ? '<1 min' : `${diff} min`;
}

function fmtTime(isoStr) {
    if (!isoStr) return '—';
    try {
        return new Date(isoStr).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return isoStr;
    }
}

function statusBadge(status) {
    const map = {
        'Esperando': '<span class="badge badge-esperando">Esperando</span>',
        'Llamado': '<span class="badge badge-llamado">Llamado</span>',
        'Atendido': '<span class="badge badge-atendido">Atendido</span>',
    };
    return map[status] || `<span class="badge bg-secondary">${status}</span>`;
}

function rowClass(status) {
    if (status === 'Llamado') return 'row-llamado';
    if (status === 'Atendido') return 'row-atendido';
    return '';
}

/* ──────────────────────────────────────────────
   Toast
────────────────────────────────────────────── */
function showToast(message, type = 'success') {
    const toastEl = document.getElementById('actionToast');
    const toastMsg = document.getElementById('toastMessage');
    if (!toastEl || !toastMsg) return;

    toastEl.className = `toast align-items-center text-white border-0 bg-${type === 'success' ? 'success' : 'danger'}`;
    toastMsg.textContent = message;

    const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
    toast.show();
}

/* ──────────────────────────────────────────────
   Metrics (KPI cards)
────────────────────────────────────────────── */
async function loadMetrics() {
    try {
        const data = await apiFetch('/api/manager/metrics');
        document.getElementById('kpiCurrentServing').textContent = data.current_serving ?? '—';
        document.getElementById('kpiWaiting').textContent = data.waiting_count ?? '0';
        document.getElementById('kpiServedToday').textContent = data.served_today ?? '0';
        document.getElementById('kpiAvgWait').textContent =
            data.avg_wait_minutes !== null && data.avg_wait_minutes !== undefined
                ? data.avg_wait_minutes
                : '—';
    } catch (e) {
        console.error('Error loading metrics:', e);
    }
}

/* ──────────────────────────────────────────────
   Queue table
────────────────────────────────────────────── */
async function loadManagerQueue() {
    try {
        const records = await apiFetch('/api/manager/queue');
        renderQueueTable(records);
        document.getElementById('queueCount').textContent = `${records.length} en cola`;
    } catch (e) {
        console.error('Error loading manager queue:', e);
        const tbody = document.getElementById('managerQueueBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center py-3 text-danger small">
                Error al cargar la cola. <button class="btn btn-link btn-sm p-0" onclick="loadManagerQueue()">Reintentar</button>
            </td></tr>`;
        }
    }
}

function renderQueueTable(records) {
    const tbody = document.getElementById('managerQueueBody');
    if (!tbody) return;

    if (records.length === 0) {
        tbody.innerHTML = `
            <tr>
              <td colspan="8">
                <div class="empty-state">
                  <i class="bi bi-inbox"></i>
                  <p>No hay pacientes en cola.</p>
                </div>
              </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = [...records].reverse().map((r, idx) => {
        const isAtendido = r.status === 'Atendido';
        const isEsperando = r.status === 'Esperando';
        const isLlamado = r.status === 'Llamado';

        // Disable call/serve buttons when not applicable
        const callDisabled = !isEsperando ? 'disabled' : '';
        const serveDisabled = isAtendido ? 'disabled' : '';
        const upDisabled = idx === 0 ? 'disabled' : '';
        const downDisabled = idx === records.length - 1 ? 'disabled' : '';

        // Only show reorder for non-attended records
        const reorderButtons = isAtendido ? '' : `
            <button class="btn btn-outline-secondary btn-sm btn-reorder me-1"
                    onclick="reorderTurn(${r.turn}, 'up')" ${upDisabled} title="Subir en cola">
                <i class="bi bi-arrow-up"></i>
            </button>
            <button class="btn btn-outline-secondary btn-sm btn-reorder"
                    onclick="reorderTurn(${r.turn}, 'down')" ${downDisabled} title="Bajar en cola">
                <i class="bi bi-arrow-down"></i>
            </button>
        `;

        return `
            <tr class="${rowClass(r.status)}">
                <td><strong class="fs-6">${r.turn}</strong></td>
                <td>
                    <div class="fw-semibold">${r.name}</div>
                </td>
                <td><span class="text-muted">${r.dni}</span></td>
                <td>
                    <span class="badge bg-light text-dark border">${r.appointment_type}</span>
                </td>
                <td>${fmtTime(r.arrival_time)}</td>
                <td>${isAtendido
                ? minutesActualWait(r.arrival_time, r.served_time)
                : `<span class="live-wait">${minutesWaiting(r.arrival_time)}</span>`
            }</td>
                <td>${statusBadge(r.status)}</td>
                <td>
                    <div class="d-flex flex-wrap gap-1 align-items-center">
                        <button class="btn btn-sm btn-outline-info" onclick="callTurn(${r.turn})"
                                ${callDisabled} title="Llamar a este turno">
                            <i class="bi bi-megaphone me-1"></i>Llamar
                        </button>
                        <button class="btn btn-sm btn-outline-success" onclick="serveTurn(${r.turn})"
                                ${serveDisabled} title="Marcar como atendido">
                            <i class="bi bi-check2-circle me-1"></i>Atender
                        </button>
                        ${reorderButtons}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

/* ──────────────────────────────────────────────
   Actions
────────────────────────────────────────────── */
async function callTurn(turn) {
    try {
        await apiFetch(`/api/manager/call/${turn}`, { method: 'POST' });
        showToast(`Turno ${turn} llamado correctamente.`, 'success');
        await loadManagerQueue();
        await loadMetrics();
    } catch (e) {
        showToast(`Error al llamar turno ${turn}: ${e.message}`, 'error');
    }
}

async function serveTurn(turn) {
    try {
        await apiFetch(`/api/manager/serve/${turn}`, { method: 'POST' });
        showToast(`Turno ${turn} marcado como Atendido.`, 'success');
        await loadManagerQueue();
        await loadMetrics();
    } catch (e) {
        showToast(`Error al atender turno ${turn}: ${e.message}`, 'error');
    }
}

async function resetDemo() {
    if (!confirm('⚠️ ¿Seguro que deseas reiniciar la demo?\nSe eliminarán todos los turnos y sesiones de chat activas.')) return;
    const btn = document.getElementById('btnResetDemo');
    if (btn) btn.disabled = true;
    try {
        await apiFetch('/api/manager/reset', { method: 'POST' });
        showToast('Demo reiniciada correctamente. Cola vacía.', 'success');
        await loadManagerQueue();
        await loadMetrics();
    } catch (e) {
        showToast(`Error al reiniciar: ${e.message}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function reorderTurn(turn, direction) {
    try {
        await apiFetch('/api/manager/reorder', {
            method: 'POST',
            body: JSON.stringify({ turn, direction }),
        });
        await loadManagerQueue();
    } catch (e) {
        showToast(`Error al reordenar: ${e.message}`, 'error');
    }
}

/* ──────────────────────────────────────────────
   Auto-poll every 5 seconds
────────────────────────────────────────────── */
function startPolling() {
    loadManagerQueue();
    loadMetrics();
    setInterval(() => {
        loadManagerQueue();
        loadMetrics();
    }, 5000);
}

/* ──────────────────────────────────────────────
   Init
────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    startPolling();
});
