from __future__ import annotations

import anthropic
import os
import re
import uuid
import json
import time
from dataclasses import dataclass
from typing import List, Dict, Any, Optional, Literal

from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# Optional PDF extraction
try:
    from pypdf import PdfReader  # type: ignore
except Exception:
    PdfReader = None


APP_NAME = "ExamGen"
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = FastAPI(title=APP_NAME)
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")


# ---------------------------
# In-memory storage (MVP)
# ---------------------------
EXAMS: Dict[str, Dict[str, Any]] = {}  # exam_id -> exam data


# ---------------------------
# Helpers
# ---------------------------
def clean_text(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"\s+", " ", s)
    return s


def safe_int(val: str, default: int, min_v: int, max_v: int) -> int:
    try:
        n = int(val)
    except Exception:
        return default
    return max(min_v, min(max_v, n))


def extract_pdf_text(file_path: str) -> str:
    if PdfReader is None:
        return ""
    try:
        reader = PdfReader(file_path)
        parts = []
        for p in reader.pages[:25]:  # limit for safety
            t = p.extract_text() or ""
            parts.append(t)
        return clean_text("\n".join(parts))
    except Exception:
        return ""


def naive_keywords(text: str, limit: int = 10) -> List[str]:
    text = text.lower()
    words = re.findall(r"[a-zA-Z]{4,}", text)
    freq: Dict[str, int] = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1
    ranked = sorted(freq.items(), key=lambda x: (-x[1], x[0]))
    return [w for w, _ in ranked[:limit]]


def grade_from_percent(p: float) -> str:
    if p <= 49:
        return "Needs Improvement"
    if p <= 69:
        return "Not Bad"
    if p <= 89:
        return "Good"
    if p <= 98:
        return "Very Good"
    return "Excellent"


def make_mcq(question: str, correct: str, distractors: List[str], explanation: str) -> Dict[str, Any]:
    opts = [correct] + distractors[:3]
    # simple shuffle but stable (seed by question)
    seed = sum(ord(c) for c in question) % 999
    for i in range(len(opts)):
        j = (seed + i * 7) % len(opts)
        opts[i], opts[j] = opts[j], opts[i]
    letters = ["A", "B", "C", "D"]
    options = [{"key": letters[i], "text": opts[i]} for i in range(4)]
    answer_key = next(o["key"] for o in options if o["text"] == correct)
    return {
        "type": "mcq",
        "q": question,
        "options": options,
        "answer": answer_key,
        "explain": explanation
    }


def make_written(question: str, model: str, key_points: List[str], marks: int = 3) -> Dict[str, Any]:
    return {
        "type": "written",
        "q": question,
        "model": model,
        "key_points": key_points,
        "marks": marks
    }


def generate_exam(
    topic_or_notes: str,
    difficulty: Literal["easy", "medium", "hard", "mixed"],
    qtype: Literal["mcq", "written", "both"],
    num_questions: int,
    include_answers: bool,
) -> Dict[str, Any]:
    """
    NOTE: This is a smart-template generator (no external AI API).
    Later you can plug LLM easily.
    """
    base = clean_text(topic_or_notes)
    if not base:
        base = "General Knowledge"

    # derive simple keywords
    keys = naive_keywords(base, limit=12)
    if not keys:
        keys = ["concept", "definition", "example", "application", "process", "output"]

    # difficulty distribution
    if difficulty == "easy":
        diffs = ["easy"] * num_questions
    elif difficulty == "medium":
        diffs = ["medium"] * num_questions
    elif difficulty == "hard":
        diffs = ["hard"] * num_questions
    else:
        # mixed: 40% easy, 40% medium, 20% hard
        diffs = []
        for i in range(num_questions):
            r = i / max(1, num_questions - 1)
            if r < 0.4:
                diffs.append("easy")
            elif r < 0.8:
                diffs.append("medium")
            else:
                diffs.append("hard")

    # question type distribution
    types: List[str] = []
    if qtype == "mcq":
        types = ["mcq"] * num_questions
    elif qtype == "written":
        types = ["written"] * num_questions
    else:
        # both: alternate, slightly more mcq for large sets
        for i in range(num_questions):
            types.append("mcq" if i % 2 == 0 else "written")

    questions: List[Dict[str, Any]] = []
    for i in range(num_questions):
        k = keys[i % len(keys)]
        d = diffs[i]
        t = types[i]

        if t == "mcq":
            q = f"[{d.upper()}] {k}: Choose the best answer."
            correct = f"Correct idea about {k}"
            distractors = [
                f"Partially correct idea about {k}",
                f"Incorrect idea about {k}",
                f"Not enough information about {k}"
            ]
            exp = f"{k} ka correct option woh hota hai jo definition + context ke saath match kare."
            questions.append(make_mcq(q, correct, distractors, exp))
        else:
            if d == "easy":
                q = f"[EASY] Explain {k} with one example."
                model = f"{k} ka matlab: clear definition. Example: real use-case. (Short, direct.)"
                kp = [f"{k} ki definition", "1 example", "Correct terms"]
                m = 3
            elif d == "medium":
                q = f"[MEDIUM] Describe how {k} works and write 2 key points."
                model = f"{k} ka working: step-by-step. 2 key points: benefits/limits."
                kp = ["Steps/flow", "2 key points", "Clarity"]
                m = 5
            else:
                q = f"[HARD] Apply {k} to a scenario and justify your answer."
                model = "Scenario → reasoning → conclusion. Mention assumptions + limitations."
                kp = ["Scenario handling", "Reasoning", "Justification", "Terminology"]
                m = 8

            questions.append(make_written(q, model, kp, marks=m))

    return {
        "title": f"Test Paper: {clean_text(base)[:40]}",
        "meta": {
            "difficulty": difficulty,
            "qtype": qtype,
            "include_answers": include_answers,
        },
        "questions": questions
    }


def score_written(user_text: str, key_points: List[str]) -> float:
    """
    Lightweight scorer:
    - keyword overlap with key_points words
    - length sanity
    """
    u = clean_text(user_text).lower()
    if not u:
        return 0.0

    # build target tokens from key_points
    target = set()
    for kp in key_points:
        for w in re.findall(r"[a-zA-Z]{3,}", kp.lower()):
            target.add(w)

    if not target:
        return 50.0

    tokens = set(re.findall(r"[a-zA-Z]{3,}", u))
    hit = len(target.intersection(tokens))
    ratio = hit / max(1, len(target))

    # length bonus/penalty
    length = len(u)
    if length < 20:
        ratio *= 0.7
    elif length > 500:
        ratio *= 0.95

    return max(0.0, min(100.0, ratio * 100.0))


# ---------------------------
# Routes (UI)
# ---------------------------

@app.get("/", response_class=HTMLResponse)
def welcome_page(request: Request):
    return templates.TemplateResponse("welcome.html", {"request": request})

@app.get("/create", response_class=HTMLResponse)
def create_page(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/create")
async def create_test(
    request: Request,
    topic: str = Form(""),
    difficulty: str = Form("easy"),
    question_type: str = Form("mcq"),
    num_questions: str = Form("10"),
    timer_minutes: str = Form("0"),
    include_answers: str = Form("yes"),
    exam_mode: str = Form("practice"),
    file: Optional[UploadFile] = File(None),
):
    topic = clean_text(topic)
    num_q = safe_int(num_questions, default=10, min_v=3, max_v=50)
    timer_m = safe_int(timer_minutes, default=0, min_v=0, max_v=180)

    include_ans_bool = (include_answers.lower() == "yes")
    difficulty = difficulty.lower()
    question_type = question_type.lower()
    exam_mode = exam_mode.lower()

    # file handling
    extracted = ""
    filename = ""
    if file and file.filename:
        filename = f"{uuid.uuid4().hex}_{file.filename}"
        fpath = os.path.join(UPLOAD_DIR, filename)
        content = await file.read()
        with open(fpath, "wb") as f:
            f.write(content)

        # extract PDF text if possible
        if file.filename.lower().endswith(".pdf"):
            extracted = extract_pdf_text(fpath)
        else:
            # image OCR not included in this version
            extracted = ""

    source_text = extracted if extracted else topic
    exam_doc = generate_exam(
        topic_or_notes=source_text,
        difficulty=difficulty if difficulty in ("easy", "medium", "hard", "mixed") else "easy",
        qtype=question_type if question_type in ("mcq", "written", "both") else "mcq",
        num_questions=num_q,
        include_answers=include_ans_bool,
    )

    exam_id = str(uuid.uuid4())
    EXAMS[exam_id] = {
        "id": exam_id,
        "created_at": int(time.time()),
        "title": exam_doc["title"],
        "meta": {
            **exam_doc["meta"],
            "timer_minutes": timer_m,
            "mode": exam_mode,  # practice/exam
            "uploaded_file": filename,
            "has_extracted": bool(extracted),
        },
        "questions": exam_doc["questions"],
        "submitted": False,
        "result": None,
    }
    

    # Redirect to new page
    return RedirectResponse(url=f"/exam/{exam_id}", status_code=303)


@app.get("/exam/{exam_id}", response_class=HTMLResponse)
def exam_page(request: Request, exam_id: str):
    if exam_id not in EXAMS:
        return HTMLResponse("Exam not found", status_code=404)
    return templates.TemplateResponse("exam.html", {"request": request, "app_name": APP_NAME})


@app.get("/waitlist", response_class=HTMLResponse)
def waitlist_page(request: Request):
    return templates.TemplateResponse("waitlist.html", {"request": request})

@app.post("/api/generate-questions")
async def generate_questions_ai(request: Request):
    body = await request.json()
    topic = clean_text(body.get("topic", "General Knowledge"))
    exam_format = body.get("exam_format", "CBSE")  # JEE / NEET / CBSE / Quick Test
    num_questions = safe_int(str(body.get("num_questions", 10)), 10, 3, 30)

    difficulty_map = {
        "JEE": "hard, conceptual, numerical, multi-step reasoning",
        "NEET": "medium-hard, biology/chemistry/physics based, factual + application",
        "CBSE": "medium, NCERT-aligned, definition and application based",
        "Quick Test": "easy to medium, fast recall"
    }
    difficulty_desc = difficulty_map.get(exam_format, "medium")

    prompt = f"""You are an expert Indian exam question setter for {exam_format}.
Generate exactly {num_questions} multiple choice questions on the topic: "{topic}".
Difficulty: {difficulty_desc}.
Style: PYQ (past year question) style — clear, unambiguous, exam-ready.

Rules:
- Each question must have exactly 4 options: A, B, C, D
- Exactly one correct answer
- Include a brief explanation (1-2 lines) for the correct answer
- Questions must be topic-specific, not generic

Respond ONLY with a valid JSON array. No preamble, no markdown, no backticks.
Format:
[
  {{
    "q": "Question text here?",
    "options": [
      {{"key": "A", "text": "Option A"}},
      {{"key": "B", "text": "Option B"}},
      {{"key": "C", "text": "Option C"}},
      {{"key": "D", "text": "Option D"}}
    ],
    "answer": "A",
    "explain": "Brief explanation of why A is correct."
  }}
]"""

    try:
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}]
        )
        raw = message.content[0].text.strip()
        # strip markdown fences if any
        raw = re.sub(r"^```json|^```|```$", "", raw, flags=re.MULTILINE).strip()
        questions = json.loads(raw)
        # tag each as mcq type
        for q in questions:
            q["type"] = "mcq"
        return JSONResponse({"ok": True, "questions": questions})
    except json.JSONDecodeError:
        return JSONResponse({"ok": False, "error": "AI returned invalid JSON"}, status_code=500)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
```

---

**Why Claude Haiku?**
- Cheapest model, fast, your free credits will last way longer
- Good enough for MCQ generation

---

**Step 3 — Frontend change**

In your `index.html` form submit, instead of POSTing to `/create` directly, you'll first call `/api/generate-questions`, get AI questions, store them, then redirect to exam. But this touches your frontend JS.

**Can you paste the form submit JS from `index.html`?** Or share:
```
https://raw.githubusercontent.com/Rahul810-koder/test-lele/main/templates/index.html

@app.post("/api/store-exam")
async def store_exam(request: Request):
    body = await request.json()
    topic = clean_text(body.get("topic", "General Knowledge"))
    questions = body.get("questions", [])
    timer_m = int(body.get("timer_minutes", 0))
    difficulty = body.get("difficulty", "medium")
    mode = body.get("mode", "practice")

    exam_id = str(uuid.uuid4())
    EXAMS[exam_id] = {
        "id": exam_id,
        "created_at": int(time.time()),
        "title": f"Test: {topic[:40]}",
        "meta": {
            "difficulty": difficulty,
            "qtype": "mcq",
            "include_answers": True,
            "timer_minutes": timer_m,
            "mode": mode,
            "ai_generated": True,
        },
        "questions": questions,
        "submitted": False,
        "result": None,
    }
    return JSONResponse({"exam_id": exam_id})
# ---------------------------
# API (Exam data + submit)
# ---------------------------
@app.get("/api/exam/{exam_id}")
def api_get_exam(exam_id: str):
    exam = EXAMS.get(exam_id)
    if not exam:
        return JSONResponse({"error": "Exam not found"}, status_code=404)

    # Return safe data for client
    # If mode == exam, do NOT send answers/explanations (until submitted)
    mode = exam["meta"].get("mode", "practice")
    include_answers = exam["meta"].get("include_answers", True)

    questions_out = []
    for idx, q in enumerate(exam["questions"], start=1):
        base = {
            "id": idx,
            "type": q["type"],
            "q": q["q"],
        }
        if q["type"] == "mcq":
            base["options"] = q["options"]
            # answers only if practice mode OR include_answers=false? (still hide in exam mode)
            if mode == "practice" and include_answers:
                base["answer"] = q["answer"]
                base["explain"] = q["explain"]
        else:
            base["marks"] = q.get("marks", 3)
            if mode == "practice" and include_answers:
                base["model"] = q["model"]
                base["key_points"] = q["key_points"]

        questions_out.append(base)

    return {
        "id": exam["id"],
        "title": exam["title"],
        "meta": exam["meta"],
        "questions": questions_out,
        "submitted": exam["submitted"],
        "result": exam["result"],
    }


@app.post("/api/submit/{exam_id}")
async def api_submit_exam(exam_id: str, payload: Dict[str, Any]):
    exam = EXAMS.get(exam_id)
    if not exam:
        return JSONResponse({"error": "Exam not found"}, status_code=404)

    answers: Dict[str, Any] = payload.get("answers", {})
    time_over = bool(payload.get("time_over", False))

    # lock submission (prevent resubmit)
    if exam["submitted"]:
        return {"ok": True, "submitted": True, "result": exam["result"]}

    total_marks = 0.0
    got_marks = 0.0

    missing_points: List[str] = []
    feedback_lines: List[str] = []

    for idx, q in enumerate(exam["questions"], start=1):
        qid = str(idx)
        if q["type"] == "mcq":
            total_marks += 1
            user = (answers.get(qid) or "").strip().upper()
            if user == q["answer"]:
                got_marks += 1
            else:
                missing_points.append(f"Q{idx}: Review concept behind the correct option.")
        else:
            marks = float(q.get("marks", 3))
            total_marks += marks
            user_text = str(answers.get(qid) or "")
            score_pct = score_written(user_text, q.get("key_points", []))
            # convert to marks
            got_marks += (score_pct / 100.0) * marks
            if score_pct < 60:
                missing_points.append(f"Q{idx}: Include key points + clearer structure.")

    percent = 0.0 if total_marks == 0 else (got_marks / total_marks) * 100.0
    percent = round(percent, 2)
    grade = grade_from_percent(percent)

    # feedback
    if percent < 50:
        feedback_lines.append("Focus on core concepts and write clearer answers.")
    elif percent < 70:
        feedback_lines.append("Good start. Add more key points and improve accuracy.")
    elif percent < 90:
        feedback_lines.append("Nice work. Improve completeness and examples.")
    else:
        feedback_lines.append("Excellent! Keep practicing and refine explanation style.")

    if time_over:
        feedback_lines.append("Time finished — answers were auto-submitted and locked.")

    result = {
        "score": f"{round(got_marks,2)}/{round(total_marks,2)}",
        "percentage": percent,
        "grade": grade,
        "feedback": " ".join(feedback_lines),
        "missing_points": missing_points[:8],
        "suggested_revision": [
            "Revise definitions + examples",
            "Practice application-based questions",
            "Write answers with structure (point-wise)",
        ],
        "answer_key": build_answer_key(exam),  # after submit we can show answers
    }

    exam["submitted"] = True
    exam["result"] = result

    return {"ok": True, "submitted": True, "result": result}


def build_answer_key(exam: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for idx, q in enumerate(exam["questions"], start=1):
        if q["type"] == "mcq":
            out[str(idx)] = {
                "type": "mcq",
                "answer": q["answer"],
                "explain": q["explain"],
            }
        else:
            out[str(idx)] = {
                "type": "written",
                "model": q["model"],
                "key_points": q["key_points"],
                "marks": q.get("marks", 3),
            }
    return out
