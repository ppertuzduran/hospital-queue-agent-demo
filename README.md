# Gestión de Colas — project4

Demo web app for hospital queue management, built with **FastAPI** (backend) and **vanilla JS + HTML + CSS** (frontend).  
Visually consistent with `project3` (same Bootstrap 5 design system, navbar, hero, table cards, floating chat FABs).

---

## Quick Start

### 1. Activate your virtual environment

```bash
# PowerShell (Windows)
.\.venv\Scripts\Activate.ps1

# bash / zsh (Mac / Linux)
source .venv/bin/activate
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Run the app

```bash
python main.py
```

Or alternatively:

```bash
uvicorn main:app --reload
```

### 4. Open in browser

| Page | URL |
|---|---|
| Patient portal | http://localhost:8000/patient |
| Manager dashboard | http://localhost:8000/manager |
| API docs (auto) | http://localhost:8000/docs |

---

## Pages

### `/patient` — Patient Portal
- Shows the **current serving number** and the patient's own turn (after completing the chatbot flow).
- Live queue table (refreshes every 5 s) — shows turn, appointment type, status, minutes waiting.
- **Chatbot FAB** (blue button, bottom-right): opens the queue assistant widget.
  - Asks for DNI → greets by name → confirms appointment → assigns turn number.
  - Follow-up: *"¿cuánto me falta?"* → replies with current number and estimated wait.
  - Follow-up: *"¿cuál es el nombre del doctor?"* → replies with doctor name and desk.

### `/manager` — Manager Dashboard
- KPI cards: **Atendiendo N°**, **En espera**, **Atendidas hoy**, **Promedio espera (min)**.
- Queue table: Turno, Nombre, DNI, Tipo de cita, Hora de llegada, Min. esperando, Estado, Acciones.
- Actions per row: **Llamar** (marks current serving), **Atender** (marks completed), **↑ / ↓** (reorder).
- Auto-polls every 5 s; manual **Actualizar** button.
- **Manager Agent FAB** (green, bottom-right): placeholder — *Próximamente*.

---

## Demo seed patients

| DNI | Nombre | Tipo |
|---|---|---|
| 12345678 | José María Roca | Radiología |
| 87654321 | Ana Lucía Pérez | Laboratorio |
| 11223344 | Carlos Mendoza Torres | Ingreso |
| 55667788 | María Fernanda López | Radiología |
| 99001122 | Diego Alejandro Ríos | Laboratorio |
| 33445566 | Patricia Soto Gómez | Ingreso |

Any unknown DNI will receive a deterministically generated demo profile.

---

## Project structure

```
project4/
├── main.py                  FastAPI app (all routes + chatbot state machine)
├── requirements.txt
├── config.json              API key (same as project3; not committed)
├── config.example.json
├── README.md
├── data/
│   └── db.json              File-based JSON "database" (atomic writes with lock)
├── templates/
│   ├── base.html            Navbar, hero, FABs, panel layout
│   ├── patient_queue.html   Patient page
│   └── manager_queue.html   Manager page
└── static/
    ├── css/
    │   └── styles.css       Adapted from project3
    ├── js/
    │   ├── patient_queue.js
    │   └── manager_queue.js
    └── images/
        ├── hero.jpg
        └── logo-megafy.png
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/queue/status` | Current serving, next turn, waiting count |
| POST | `/api/patient/start` | Look up patient by DNI |
| POST | `/api/patient/confirm` | Confirm arrival, assign turn |
| POST | `/api/patient/chat` | Chatbot state machine |
| GET | `/api/manager/queue` | All queue records (ordered) |
| POST | `/api/manager/call/{turn}` | Call a turn (set as current) |
| POST | `/api/manager/serve/{turn}` | Mark turn as attended |
| POST | `/api/manager/reorder` | Move turn up or down |
| GET | `/api/manager/metrics` | KPI metrics |
| GET | `/api/config` | API key (for future LLM integration) |
| GET | `/docs` | Swagger UI |
