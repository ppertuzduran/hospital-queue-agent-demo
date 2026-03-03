"""
FastAPI Backend for Gestión de Colas (Queue Management)
Provides REST API endpoints and serves the frontend templates.
Follows the same architecture as project3 but uses FastAPI instead of Flask.
"""

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from typing import Optional
import json
import os
from datetime import datetime
from threading import Lock
import io
import base64

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

# ──────────────────────────────────────────────
# App setup
# ──────────────────────────────────────────────
app = FastAPI(title="Gestión de Colas", version="1.0.0")

# Trust Railway (and any reverse-proxy) forwarded headers so that
# request.url_for() generates https:// URLs in production.
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")


BASE_DIR = os.path.dirname(__file__)
DB_FILE = os.path.join(BASE_DIR, "data", "db.json")
os.makedirs(os.path.join(BASE_DIR, "data"), exist_ok=True)

app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

db_lock = Lock()

# ──────────────────────────────────────────────
# Auto-seed: if db.json is missing (e.g. fresh Railway deploy),
# restore from seed_snapshot.json so the demo data is always present.
# ──────────────────────────────────────────────
SNAPSHOT_FILE = os.path.join(BASE_DIR, "data", "seed_snapshot.json")
if not os.path.exists(DB_FILE) and os.path.exists(SNAPSHOT_FILE):
    import shutil
    shutil.copy2(SNAPSHOT_FILE, DB_FILE)


# ──────────────────────────────────────────────
# In-memory chat sessions  { session_id: {state, dni, ...} }
# ──────────────────────────────────────────────
chat_sessions: dict = {}

# ──────────────────────────────────────────────
# DB helpers  (mirror project3 approach: temp-write + os.replace)
# ──────────────────────────────────────────────

def read_db() -> dict:
    with db_lock:
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return {
                "schema": {"appointment_types": ["Radiologia", "Laboratorio", "Ingreso", "Urgencias"], "status": ["Esperando", "Llamado", "Atendido"]},
                "seed_patients": [],
                "queue_state": {"current_serving": 48, "next_turn_number": 50},
                "queue_records": [],
            }


def write_db(data: dict) -> None:
    with db_lock:
        temp = DB_FILE + ".tmp"
        with open(temp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(temp, DB_FILE)


def find_seed_patient(dni: str) -> Optional[dict]:
    """Look up a patient in seed_patients by DNI."""
    db = read_db()
    return next((p for p in db["seed_patients"] if p["dni"] == dni), None)


def generate_demo_patient(dni: str) -> dict:
    """
    For unknown DNIs, return a deterministically generated demo profile
    so the demo always produces the same result for a given DNI.
    """
    types = ["Radiología", "Laboratorio", "Ingreso"]
    doctors = ["Dr. Marco Polo", "Dra. Ana González", "Dr. Héctor Martínez"]
    desks = ["Mesón 1", "Mesón 2", "Mesón 3"]
    idx = int(dni[-1]) % 3
    return {
        "dni": dni,
        "name": f"Paciente {dni[-4:]}",
        "appointment_type": types[idx],
        "doctor_name": doctors[idx],
        "desk": desks[idx],
    }


def compute_wait_minutes(arrival_iso: str, current_serving: int, patient_turn: int) -> int:
    """Estimate waiting minutes based on turns ahead and avg 5 min/turn."""
    turns_ahead = max(0, patient_turn - current_serving - 1)
    return turns_ahead * 5


# ──────────────────────────────────────────────
# Pydantic models
# ──────────────────────────────────────────────

class PatientStartRequest(BaseModel):
    dni: str


class PatientConfirmRequest(BaseModel):
    dni: str
    confirm: bool


class ChatRequest(BaseModel):
    session_id: str
    message: str


class ReorderRequest(BaseModel):
    turn: int
    direction: str  # "up" | "down"


# ──────────────────────────────────────────────
# HTML page routes
# ──────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def root(request: Request):
    return templates.TemplateResponse("patient_queue.html", {"request": request})


@app.get("/patient", response_class=HTMLResponse)
async def patient_page(request: Request):
    return templates.TemplateResponse("patient_queue.html", {"request": request})


@app.get("/manager", response_class=HTMLResponse)
async def manager_page(request: Request):
    return templates.TemplateResponse("manager_queue.html", {"request": request})


# ──────────────────────────────────────────────
# API: queue status
# ──────────────────────────────────────────────

@app.get("/api/queue/status")
async def get_queue_status():
    db = read_db()
    qs = db["queue_state"]
    waiting = sum(1 for r in db["queue_records"] if r["status"] == "Esperando")
    return {
        "current_serving": qs["current_serving"],
        "next_turn_number": qs["next_turn_number"],
        "waiting_count": waiting,
    }


# ──────────────────────────────────────────────
# API: patient simulation
# ──────────────────────────────────────────────

@app.post("/api/patient/start")
async def patient_start(body: PatientStartRequest):
    """Look up patient by DNI; return profile + appointment info."""
    patient = find_seed_patient(body.dni)
    if not patient:
        patient = generate_demo_patient(body.dni)
    return {
        "found": True,
        "dni": patient["dni"],
        "name": patient["name"],
        "appointment_type": patient["appointment_type"],
        "doctor_name": patient["doctor_name"],
        "desk": patient["desk"],
    }


@app.post("/api/patient/confirm")
async def patient_confirm(body: PatientConfirmRequest):
    """Confirm arrival: assign turn number, create queue record."""
    if not body.confirm:
        return {"confirmed": False, "message": "OK, vuelve a intentar cuando estés listo."}

    patient = find_seed_patient(body.dni)
    if not patient:
        patient = generate_demo_patient(body.dni)

    db = read_db()
    qs = db["queue_state"]

    # Check if this DNI already has an active record (avoid duplicates)
    existing = next(
        (r for r in db["queue_records"] if r["dni"] == body.dni and r["status"] in ("Esperando", "Llamado")),
        None,
    )
    if existing:
        turns_ahead = max(0, existing["turn"] - qs["current_serving"] - 1)
        return {
            "confirmed": True,
            "already_registered": True,
            "turn": existing["turn"],
            "estimated_wait_minutes": turns_ahead * 5,
            "current_serving": qs["current_serving"],
            "desk": existing["desk"],
            "doctor_name": existing["doctor_name"],
        }

    turn = qs["next_turn_number"]
    qs["next_turn_number"] = turn + 1

    record = {
        "turn": turn,
        "order": len(db["queue_records"]),
        "dni": patient["dni"],
        "name": patient["name"],
        "appointment_type": patient["appointment_type"],
        "doctor_name": patient["doctor_name"],
        "arrival_time": datetime.now().isoformat(timespec="seconds"),
        "called_time": None,
        "served_time": None,
        "status": "Esperando",
        "desk": patient["desk"],
    }
    db["queue_records"].append(record)
    write_db(db)

    turns_ahead = max(0, turn - qs["current_serving"] - 1)
    return {
        "confirmed": True,
        "already_registered": False,
        "turn": turn,
        "estimated_wait_minutes": turns_ahead * 5,
        "current_serving": qs["current_serving"],
        "desk": patient["desk"],
        "doctor_name": patient["doctor_name"],
    }


# ──────────────────────────────────────────────
# API: patient chatbot (state machine, no external LLM)
# ──────────────────────────────────────────────

STATES = {
    "ASK_DNI": "ASK_DNI",
    "SHOW_APPT_CONFIRM": "SHOW_APPT_CONFIRM",
    "ASSIGNED": "ASSIGNED",
}


def _normalize(text: str) -> str:
    return text.lower().strip()


@app.post("/api/patient/chat")
async def patient_chat(body: ChatRequest):
    """
    Deterministic state-machine chatbot.
    States: ASK_DNI → SHOW_APPT_CONFIRM → ASSIGNED
    Also handles follow-up questions in ASSIGNED state.
    """
    sid = body.session_id
    msg = body.message.strip()
    norm = _normalize(msg)

    # Initialise session
    if sid not in chat_sessions:
        chat_sessions[sid] = {"state": STATES["ASK_DNI"], "patient": None, "turn": None}

    session = chat_sessions[sid]
    state = session["state"]

    db = read_db()
    qs = db["queue_state"]

    # ── ASSIGNED: handle follow-up questions ──────────────────
    if state == STATES["ASSIGNED"]:
        # If the user types a new DNI while already assigned, reset and treat as a new patient
        dni_candidate = "".join(filter(str.isdigit, msg))
        if len(dni_candidate) >= 6:
            new_patient = find_seed_patient(dni_candidate)
            if not new_patient:
                new_patient = generate_demo_patient(dni_candidate)
            session["state"] = STATES["SHOW_APPT_CONFIRM"]
            session["patient"] = new_patient
            session["turn"] = None
            return {
                "reply": (
                    f"¡Hola, **{new_patient['name']}**! 👋\n\n"
                    f"Encontré tu cita de **{new_patient['appointment_type']}** con **{new_patient['doctor_name']}** "
                    f"en el {new_patient['desk']}.\n\n"
                    "¿Confirmas tu llegada? Responde **Sí** para obtener tu número de turno."
                )
            }

        patient = session["patient"]
        turn = session["turn"]

        # "¿cuánto me falta?" or similar
        if any(kw in norm for kw in ["cuánto", "cuanto", "falta", "espera", "tiempo", "minutos", "turno"]):
            turns_ahead = max(0, turn - qs["current_serving"] - 1)
            wait = turns_ahead * 5
            wait = min(turns_ahead + 1, 4)  # always 1–4 min (never ≥ 5)
            return {
                "reply": f"Actualmente se atiende el N° **{qs['current_serving']}**. "
                         f"Tu turno es el **{turn}**. "
                         f"⏱️ Tiempo estimado: **{wait} minuto{'s' if wait > 1 else ''}**."
            }

        # "¿cuál es el nombre del doctor?" or similar
        if any(kw in norm for kw in ["doctor", "médico", "medico", "nombre del", "quien", "quién"]):
            return {
                "reply": f"Tu cita de **{patient['appointment_type']}** está asignada con **{patient['doctor_name']}**, "
                         f"en el {patient['desk']}."
            }

        # Generic follow-up
        return {
            "reply": f"Estoy aquí para ayudarte. Tu turno es el **{turn}** y se atiende el N° **{qs['current_serving']}**. "
                     "Puedes preguntarme '¿cuánto me falta?' o '¿cuál es el nombre del doctor?'"
        }

    # ── ASK_DNI: waiting for DNI input ────────────────────────
    if state == STATES["ASK_DNI"]:
        # Accept anything that looks like a DNI (digits only, 6–12 chars) or non-empty
        dni_candidate = "".join(filter(str.isdigit, msg))
        if len(dni_candidate) >= 6:
            patient = find_seed_patient(dni_candidate)
            if not patient:
                patient = generate_demo_patient(dni_candidate)
            session["state"] = STATES["SHOW_APPT_CONFIRM"]
            session["patient"] = patient
            return {
                "reply": (
                    f"¡Hola, **{patient['name']}**! 👋\n\n"
                    f"Encontré tu cita de **{patient['appointment_type']}** con **{patient['doctor_name']}** "
                    f"en el {patient['desk']}.\n\n"
                    "¿Confirmas tu llegada? Responde **Sí** para obtener tu número de turno."
                )
            }
        else:
            return {
                "reply": "Por favor, ingresa tu **DNI o carnet de identidad** (solo números) para comenzar."
            }

    # ── SHOW_APPT_CONFIRM: waiting for confirmation ────────────
    if state == STATES["SHOW_APPT_CONFIRM"]:
        patient = session["patient"]
        if any(kw in norm for kw in ["sí", "si", "yes", "confirmo", "ok", "correcto", "claro"]):
            # Assign turn
            existing = next(
                (r for r in db["queue_records"] if r["dni"] == patient["dni"] and r["status"] in ("Esperando", "Llamado")),
                None,
            )
            if existing:
                turn = existing["turn"]
            else:
                turn = qs["next_turn_number"]
                qs["next_turn_number"] = turn + 1
                record = {
                    "turn": turn,
                    "order": len(db["queue_records"]),
                    "dni": patient["dni"],
                    "name": patient["name"],
                    "appointment_type": patient["appointment_type"],
                    "doctor_name": patient["doctor_name"],
                    "arrival_time": datetime.now().isoformat(timespec="seconds"),
                    "called_time": None,
                    "served_time": None,
                    "status": "Esperando",
                    "desk": patient["desk"],
                }
                db["queue_records"].append(record)
                write_db(db)

            session["state"] = STATES["ASSIGNED"]
            session["turn"] = turn
            turns_ahead = max(0, turn - qs["current_serving"] - 1)
            wait = turns_ahead * 5
            return {
                "reply": (
                    f"✅ ¡Registro exitoso! Tu número de turno es **{turn}**.\n\n"
                    f"🔢 Actualmente se atiende el N° **{qs['current_serving']}**.\n"
                    f"⏱️ Tiempo estimado de espera: **{wait} minutos**.\n"
                    f"📍 Dirígete al **{patient['desk']}**.\n\n"
                    "Puedes preguntarme '¿cuánto me falta?' o '¿cuál es el nombre del doctor?' en cualquier momento."
                )
            }
        elif any(kw in norm for kw in ["no", "cancelar", "cancel", "volver"]):
            session["state"] = STATES["ASK_DNI"]
            session["patient"] = None
            return {"reply": "Entendido. Cuando estés listo, ingresa tu DNI nuevamente para comenzar."}
        else:
            return {
                "reply": (
                    f"Tengo registrada tu cita de **{patient['appointment_type']}** con **{patient['doctor_name']}**.\n"
                    "¿Confirmas tu llegada? Responde **Sí** o **No**."
                )
            }

    return {"reply": "Lo siento, ocurrió un error. Por favor recarga la página."}


# ──────────────────────────────────────────────
# API: manager queue
# ──────────────────────────────────────────────

@app.get("/api/manager/queue")
async def manager_queue():
    """Return queue records sorted by order field."""
    db = read_db()
    records = sorted(db["queue_records"], key=lambda r: r.get("order", r["turn"]))
    return records


@app.post("/api/manager/call/{turn}")
async def manager_call(turn: int):
    """Call a turn: set as current_serving, status → Llamado."""
    db = read_db()
    record = next((r for r in db["queue_records"] if r["turn"] == turn), None)
    if not record:
        raise HTTPException(status_code=404, detail="Turn not found")

    db["queue_state"]["current_serving"] = turn
    record["status"] = "Llamado"
    record["called_time"] = datetime.now().isoformat(timespec="seconds")
    write_db(db)
    return {"ok": True, "turn": turn, "current_serving": turn}


@app.post("/api/manager/serve/{turn}")
async def manager_serve(turn: int):
    """Mark a turn as attended: status → Atendido."""
    db = read_db()
    record = next((r for r in db["queue_records"] if r["turn"] == turn), None)
    if not record:
        raise HTTPException(status_code=404, detail="Turn not found")

    record["status"] = "Atendido"
    record["served_time"] = datetime.now().isoformat(timespec="seconds")
    write_db(db)
    return {"ok": True, "turn": turn}


@app.post("/api/manager/reset")
async def manager_reset():
    """Restore db to the seeded 48-record snapshot, then clear chat sessions."""
    snapshot_file = os.path.join(BASE_DIR, "data", "seed_snapshot.json")
    if os.path.exists(snapshot_file):
        with open(snapshot_file, "r", encoding="utf-8") as f:
            seed_db = json.load(f)
        write_db(seed_db)
        chat_sessions.clear()
        return {"ok": True, "message": "Demo reiniciada a los 48 registros originales."}
    else:
        # Fallback: just clear the queue if snapshot is missing
        db = read_db()
        db["queue_records"] = []
        db["queue_state"] = {"current_serving": 48, "next_turn_number": 49}
        write_db(db)
        chat_sessions.clear()
        return {"ok": True, "message": "Cola reiniciada (snapshot no encontrado)."}


@app.post("/api/manager/reorder")
async def manager_reorder(body: ReorderRequest):
    """Move a queue record up or down by swapping order values."""
    db = read_db()
    records = db["queue_records"]

    # Normalise order field if missing
    for i, r in enumerate(records):
        if "order" not in r:
            r["order"] = i

    # Sort by current order
    sorted_records = sorted(records, key=lambda r: r["order"])

    # Find index of target turn
    idx = next((i for i, r in enumerate(sorted_records) if r["turn"] == body.turn), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Turn not found")

    if body.direction == "up" and idx > 0:
        sorted_records[idx]["order"], sorted_records[idx - 1]["order"] = (
            sorted_records[idx - 1]["order"],
            sorted_records[idx]["order"],
        )
    elif body.direction == "down" and idx < len(sorted_records) - 1:
        sorted_records[idx]["order"], sorted_records[idx + 1]["order"] = (
            sorted_records[idx + 1]["order"],
            sorted_records[idx]["order"],
        )

    write_db(db)
    return {"ok": True}


# ──────────────────────────────────────────────
# API: manager metrics
# ──────────────────────────────────────────────

@app.get("/api/manager/metrics")
async def manager_metrics():
    db = read_db()
    records = db["queue_records"]

    waiting_count = sum(1 for r in records if r["status"] == "Esperando")
    called_count = sum(1 for r in records if r["status"] == "Llamado")

    today = datetime.now().date().isoformat()
    served_today = [
        r for r in records
        if r["status"] == "Atendido" and r.get("served_time", "")[:10] == today
    ]
    served_count = len(served_today)

    # Average wait: served_time - arrival_time for served records today
    wait_times = []
    for r in served_today:
        try:
            arr = datetime.fromisoformat(r["arrival_time"])
            srv = datetime.fromisoformat(r["served_time"])
            wait_times.append((srv - arr).total_seconds() / 60)
        except Exception:
            pass

    avg_wait = round(sum(wait_times) / len(wait_times), 1) if wait_times else None

    return {
        "waiting_count": waiting_count,
        "called_count": called_count,
        "served_today": served_count,
        "avg_wait_minutes": avg_wait,
        "current_serving": db["queue_state"]["current_serving"],
    }


# ──────────────────────────────────────────────
# API: config (same pattern as project3)
# ──────────────────────────────────────────────

@app.get("/api/config")
async def get_config():
    """Return OpenAI API key from env or config.json (same as project3)."""
    try:
        env_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if env_key and env_key != "YOUR_API_KEY_HERE":
            return {"api_key": env_key}

        config_file = os.path.join(BASE_DIR, "config.json")
        if os.path.exists(config_file):
            with open(config_file, "r", encoding="utf-8") as f:
                config = json.load(f)
                api_key = config.get("openai_api_key", "")
                if api_key and api_key != "YOUR_API_KEY_HERE":
                    return {"api_key": api_key}

        return {"api_key": None}
    except Exception:
        return {"api_key": None}


# ──────────────────────────────────────────────
# Chart helpers  (same pattern as project3)
# ──────────────────────────────────────────────

def _apply_chart_style() -> None:
    """Apply a clean, modern Seaborn theme — identical to project3."""
    sns.set_theme(style="whitegrid", font_scale=1.15)
    plt.rcParams.update({
        "font.family":       "sans-serif",
        "font.sans-serif":   ["Segoe UI", "Arial", "DejaVu Sans"],
        "axes.spines.top":   False,
        "axes.spines.right": False,
        "axes.edgecolor":    "#cccccc",
        "grid.color":        "#eeeeee",
        "grid.linewidth":    0.8,
    })


def _to_base64_png(dpi: int = 160) -> str:
    """Save current figure to base64 PNG and close — identical to project3."""
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=dpi, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode()
    plt.close("all")
    return b64


# ──────────────────────────────────────────────
# API: chart — promedio de espera por tipo de cita
# ──────────────────────────────────────────────

@app.get("/api/charts/wait-by-appointment-type")
async def chart_wait_by_appointment_type():
    """
    Generate a Seaborn horizontal bar chart of average wait time (minutes)
    per appointment type, computed from served queue records.
    Falls back to realistic simulated values when real data is scarce.
    """
    db = read_db()
    records = db["queue_records"]

    today = datetime.now().date().isoformat()

    # Compute real averages from served records (any day, not just today)
    from collections import defaultdict
    wait_by_type: dict = defaultdict(list)
    for r in records:
        if r["status"] == "Atendido" and r.get("served_time") and r.get("arrival_time"):
            try:
                arr = datetime.fromisoformat(r["arrival_time"])
                srv = datetime.fromisoformat(r["served_time"])
                minutes = (srv - arr).total_seconds() / 60
                wait_by_type[r["appointment_type"]].append(minutes)
            except Exception:
                pass

    # Build result dict; if a type has no real data, use plausible demo values
    demo_defaults = {"Radiologia": 18.5, "Laboratorio": 12.0, "Ingreso": 32.0, "Urgencias": 8.0}
    all_types = db["schema"]["appointment_types"]

    avgs: dict = {}
    for apt in all_types:
        if wait_by_type[apt]:
            avgs[apt] = round(sum(wait_by_type[apt]) / len(wait_by_type[apt]), 1)
        else:
            avgs[apt] = demo_defaults.get(apt, 15.0)

    # Sort by descending avg wait
    sorted_items = sorted(avgs.items(), key=lambda x: x[1])
    types  = [t for t, _ in sorted_items]
    values = [v for _, v in sorted_items]

    _apply_chart_style()
    fig, ax = plt.subplots(figsize=(9, max(3.5, len(types) * 1.4)))

    import pandas as pd
    df = pd.DataFrame({"tipo": types, "minutos": values, "color": range(len(types))})
    palette = sns.color_palette("Blues_d", n_colors=max(len(types), 3))[:len(types)]
    sns.barplot(data=df, y="tipo", x="minutos", hue="color",
                palette=palette, ax=ax, orient="h",
                width=0.55, linewidth=0, legend=False)

    # Value labels at end of each bar
    for bar, val in zip(ax.patches, values):
        ax.text(
            bar.get_width() + max(values) * 0.015,
            bar.get_y() + bar.get_height() / 2,
            f"{val} min", va="center", ha="left",
            fontsize=11, fontweight="bold", color="#333333",
        )

    ax.set_xlabel("Minutos promedio de espera", fontsize=12, fontweight="bold", labelpad=8)
    ax.set_ylabel("", labelpad=0)
    ax.set_title("Promedio de Espera por Tipo de Cita", fontsize=16,
                 fontweight="bold", pad=14, color="#1a1a2e")
    ax.set_xlim(0, max(values) * 1.25)
    sns.despine(ax=ax, left=True)
    plt.tight_layout()

    img_b64 = _to_base64_png()

    total_served = sum(len(v) for v in wait_by_type.values())
    longest_type = sorted_items[-1][0]
    shortest_type = sorted_items[0][0]

    return {
        "image": f"data:image/png;base64,{img_b64}",
        "stats": {
            "averages": avgs,
            "total_served_records": total_served,
            "longest_wait_type": longest_type,
            "longest_wait_minutes": sorted_items[-1][1],
            "shortest_wait_type": shortest_type,
            "shortest_wait_minutes": sorted_items[0][1],
            "is_simulated": total_served == 0,
        },
    }


# ──────────────────────────────────────────────
# Manager agent embed page
# ──────────────────────────────────────────────

@app.get("/manager-agent/embed", response_class=HTMLResponse)
async def manager_agent_embed(request: Request):
    return templates.TemplateResponse("manager_agent_embed.html", {"request": request})


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
