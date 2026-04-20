"""
Test Lele — FastAPI Backend
AI-powered practice test generator for Indian students (JEE, NEET, CBSE)
Uses Groq API (Llama 3.3) for question generation
"""

from __future__ import annotations

import os
import re
import uuid
import json
import time
from typing import List, Dict, Any

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv

# Load .env file
load_dotenv()
print("KEY:", os.getenv("GROQ_API_KEY"))

# ─────────────────────────────────────────
# App Setup
# ─────────────────────────────────────────

APP_NAME = "TestLele"

app = FastAPI(title=APP_NAME)
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

# In-memory exam store (resets on server restart)
EXAMS: Dict[str, Dict[str, Any]] = {}


# ─────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────

def clean_text(s: str) -> str:
    """Strip and collapse whitespace."""
    s = (s or "").strip()
    return re.sub(r"\s+", " ", s)


def safe_int(val, default: int, min_v: int, max_v: int) -> int:
    """Convert to int safely and clamp to range."""
    try:
        n = int(val)
    except Exception:
        return default
    return max(min_v, min(max_v, n))


def grade_from_percent(p: float) -> str:
    """Return grade label from percentage."""
    if p <= 49: return "Needs Improvement"
    if p <= 69: return "Not Bad"
    if p <= 89: return "Good"
    if p <= 98: return "Very Good"
    return "Excellent"


def normalize_options(raw_options) -> List[Dict[str, str]]:
    """
    Normalize MCQ options to: [{"key": "A", "text": "..."}]
    Handles two formats Groq might return.
    """
    if not raw_options or not isinstance(raw_options, list):
        return []

    normalized = []
    for opt in raw_options:
        if not isinstance(opt, dict):
            continue
        # Format 1: {"key": "A", "text": "..."}
        if "key" in opt and "text" in opt and str(opt.get("text", "")).strip():
            normalized.append({
                "key": str(opt["key"]).strip().upper(),
                "text": str(opt["text"]).strip()
            })
        else:
            # Format 2: {"A": "..."}
            for k, v in opt.items():
                if k.strip().upper() in ["A", "B", "C", "D"] and str(v).strip():
                    normalized.append({
                        "key": k.strip().upper(),
                        "text": str(v).strip()
                    })

    # Deduplicate by key
    seen = set()
    result = []
    for o in normalized:
        if o["key"] not in seen:
            seen.add(o["key"])
            result.append(o)

    key_order = {"A": 0, "B": 1, "C": 2, "D": 3}
    result.sort(key=lambda x: key_order.get(x["key"], 99))
    return result


def parse_ai_response(raw: str) -> List[Dict[str, Any]]:
    """Parse JSON array from AI response, stripping markdown fences."""
    raw = re.sub(r"^```json\s*|^```\s*|```\s*$", "", raw, flags=re.MULTILINE).strip()
    match = re.search(r'\[.*\]', raw, re.DOTALL)
    if match:
        raw = match.group(0)
    return json.loads(raw)


def score_written_answer(user_text: str, key_points: List[str]) -> float:
    """
    Score a written answer 0-100 using keyword matching against key points.
    Penalizes very short answers.
    """
    u = clean_text(user_text).lower()
    if not u:
        return 0.0

    target = set()
    for kp in key_points:
        for w in re.findall(r"[a-zA-Z]{3,}", kp.lower()):
            target.add(w)

    if not target:
        return 50.0

    user_words = set(re.findall(r"[a-zA-Z]{3,}", u))
    ratio = len(target.intersection(user_words)) / max(1, len(target))

    # Length penalty for very short answers
    length = len(u)
    if length < 30:
        ratio *= 0.5
    elif length < 100:
        ratio *= 0.8

    return round(max(0.0, min(100.0, ratio * 100.0)), 2)


def build_answer_key(exam: Dict[str, Any]) -> Dict[str, Any]:
    """Build answer key from exam questions."""
    out: Dict[str, Any] = {}
    for idx, q in enumerate(exam["questions"], start=1):
        if q["type"] == "written":
            out[str(idx)] = {
                "type": "written",
                "model_answer": q.get("model_answer", ""),
                "key_points": q.get("key_points", []),
                "marks": q.get("marks", 5),
            }
        else:
            out[str(idx)] = {
                "type": "mcq",
                "answer": q.get("answer", ""),
                "explain": q.get("explain", ""),
            }
    return out


# ─────────────────────────────────────────
# Prompt Builders
# ─────────────────────────────────────────

def build_mcq_prompt(topic: str, exam_format: str, num_questions: int, difficulty_desc: str) -> str:
    return f"""You are an expert Indian exam question setter for {exam_format}.
Generate exactly {num_questions} multiple choice questions on: "{topic}".
Difficulty: {difficulty_desc}.

STRICT RULES:
1. Return ONLY a valid JSON array. No explanation, no markdown, no extra text.
2. Every question MUST have exactly 4 options with keys "A", "B", "C", "D".
3. Every option "text" field MUST be non-empty and meaningful.
4. The "answer" field MUST be exactly one of: "A", "B", "C", or "D".
5. The "explain" field must be one clear sentence.

Return this EXACT JSON structure:
[
  {{
    "q": "Question text?",
    "options": [
      {{"key": "A", "text": "First option"}},
      {{"key": "B", "text": "Second option"}},
      {{"key": "C", "text": "Third option"}},
      {{"key": "D", "text": "Fourth option"}}
    ],
    "answer": "A",
    "explain": "Why A is correct."
  }}
]"""


def build_written_prompt(topic: str, exam_format: str, num_questions: int, difficulty_desc: str) -> str:
    return f"""You are an expert Indian exam question setter for {exam_format}.
Generate exactly {num_questions} long-answer questions on: "{topic}".
Difficulty: {difficulty_desc}.

STRICT RULES:
1. Return ONLY a valid JSON array. No explanation, no markdown, no extra text.
2. Each question requires a detailed answer of 100-200 words.
3. "key_points" must be a list of 4-6 important concepts the answer must cover.
4. "model_answer" must be a complete well-structured answer (150-200 words).
5. "marks" should be between 4 and 8 based on complexity.

Return this EXACT JSON structure:
[
  {{
    "q": "Explain in detail...",
    "marks": 5,
    "key_points": ["point 1", "point 2", "point 3", "point 4"],
    "model_answer": "A detailed model answer covering all key points..."
  }}
]"""


def build_mix_prompt(topic: str, exam_format: str, num_questions: int, difficulty_desc: str) -> str:
    mcq_count = max(1, num_questions * 2 // 3)
    written_count = max(1, num_questions - mcq_count)
    return f"""You are an expert Indian exam question setter for {exam_format}.
Generate a mixed question paper on: "{topic}".
Generate exactly {mcq_count} MCQ questions AND {written_count} long-answer questions.
Difficulty: {difficulty_desc}.

STRICT RULES:
1. Return ONLY a valid JSON array containing ALL questions. No markdown, no extra text.
2. MCQ questions must have "type": "mcq" and exactly 4 options (A, B, C, D).
3. Written questions must have "type": "written" with key_points and model_answer.
4. The "explain" field for MCQ must be one sentence.
5. "key_points" for written must have 4-6 items.

Return this EXACT JSON structure:
[
  {{
    "type": "mcq",
    "q": "MCQ question?",
    "options": [
      {{"key": "A", "text": "Option A"}},
      {{"key": "B", "text": "Option B"}},
      {{"key": "C", "text": "Option C"}},
      {{"key": "D", "text": "Option D"}}
    ],
    "answer": "A",
    "explain": "Why A is correct."
  }},
  {{
    "type": "written",
    "q": "Explain in detail...",
    "marks": 5,
    "key_points": ["point 1", "point 2", "point 3"],
    "model_answer": "Detailed model answer here..."
  }}
]"""


# ─────────────────────────────────────────
# Page Routes
# ─────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def welcome_page(request: Request):
    return templates.TemplateResponse("welcome.html", {"request": request})

@app.get("/create", response_class=HTMLResponse)
def create_page(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/exam/{exam_id}", response_class=HTMLResponse)
def exam_page(request: Request, exam_id: str):
    if exam_id not in EXAMS:
        return HTMLResponse("Exam not found", status_code=404)
    return templates.TemplateResponse("exam.html", {"request": request, "app_name": APP_NAME})

@app.get("/waitlist", response_class=HTMLResponse)
def waitlist_page(request: Request):
    return templates.TemplateResponse("waitlist.html", {"request": request})


# ─────────────────────────────────────────
# AI Generation API
# ─────────────────────────────────────────

@app.post("/api/generate-questions")
async def generate_questions_ai(request: Request):
    """Generate AI questions using Groq. Supports mcq, written, mix."""
    body = await request.json()

    topic         = clean_text(body.get("topic", "General Knowledge")) or "General Knowledge"
    exam_format   = body.get("exam_format", "CBSE")
    num_questions = safe_int(body.get("num_questions", 10), 10, 3, 30)
    question_type = body.get("question_type", "mcq").lower()

    difficulty_map = {
        "JEE":        "hard, conceptual, numerical, multi-step reasoning",
        "NEET":       "medium-hard, biology/chemistry/physics based, factual + application",
        "CBSE":       "medium, NCERT-aligned, definition and application based",
        "Quick Test": "easy to medium, fast recall",
    }
    difficulty_desc = difficulty_map.get(exam_format, "medium, well-balanced")

    # Check API key exists
    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        return JSONResponse(
            {"ok": False, "error": "GROQ_API_KEY not set in .env file."},
            status_code=500
        )


    # Pick the right prompt
    if question_type == "written":
        prompt = build_written_prompt(topic, exam_format, num_questions, difficulty_desc)
    elif question_type == "mix":
        prompt = build_mix_prompt(topic, exam_format, num_questions, difficulty_desc)
    else:
        prompt = build_mcq_prompt(topic, exam_format, num_questions, difficulty_desc)

    last_error = "Unknown error"

    # Retry loop — try 3 times before giving up
    for attempt in range(3):
        try:
            from groq import Groq

            client = Groq(api_key=api_key)
            response = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=4000,
                temperature=0.7,
            )
            raw = response.choices[0].message.content.strip()

            if not raw:
                last_error = f"Empty response on attempt {attempt + 1}"
                continue

            parsed = parse_ai_response(raw)

            if not isinstance(parsed, list):
                last_error = "Response is not a list"
                continue

            valid_questions = []

            for q in parsed:
                if not isinstance(q, dict):
                    continue

                q_text = str(q.get("q", "")).strip()
                if not q_text:
                    continue

                # Determine type of this question
                q_type = str(q.get("type", "written" if question_type == "written" else "mcq")).lower()

                if q_type == "written":
                    key_points   = q.get("key_points", [])
                    model_answer = str(q.get("model_answer", "")).strip()
                    if not model_answer:
                        continue
                    valid_questions.append({
                        "type": "written",
                        "q": q_text,
                        "marks": safe_int(q.get("marks", 5), 5, 2, 10),
                        "key_points": key_points if isinstance(key_points, list) else [],
                        "model_answer": model_answer,
                    })

                else:
                    # MCQ validation
                    options = normalize_options(q.get("options", []))

                    # Fallback: check for flat A/B/C/D keys
                    if len(options) < 4:
                        rebuilt = [
                            {"key": k, "text": str(q.get(k, "")).strip()}
                            for k in ["A", "B", "C", "D"]
                            if str(q.get(k, "")).strip()
                        ]
                        if len(rebuilt) == 4:
                            options = rebuilt

                    if len(options) != 4:
                        continue

                    answer = str(q.get("answer", "A")).strip().upper()
                    if answer not in ["A", "B", "C", "D"]:
                        answer = "A"

                    option_keys = [o["key"] for o in options]
                    if answer not in option_keys:
                        answer = option_keys[0]

                    valid_questions.append({
                        "type": "mcq",
                        "q": q_text,
                        "options": options,
                        "answer": answer,
                        "explain": str(q.get("explain", "")).strip() or "See correct option.",
                    })

            if valid_questions:
                return JSONResponse({"ok": True, "questions": valid_questions})

            last_error = f"No valid questions on attempt {attempt + 1}. Raw: {raw[:300]}"

        except json.JSONDecodeError as e:
            last_error = f"JSON parse error on attempt {attempt + 1}: {str(e)}"

        except ImportError:
            return JSONResponse(
                {"ok": False, "error": "Groq not installed. Run: pip install groq"},
                status_code=500
            )

        except Exception as e:
         last_error = f"Error on attempt {attempt + 1}: {str(e)}"
         print("ACTUAL ERROR:", e)
         time.sleep(1)
    
    return JSONResponse({"ok": False, "error": last_error}, status_code=500)


# ─────────────────────────────────────────
# Store Exam API
# ─────────────────────────────────────────

@app.post("/api/store-exam")
async def store_exam(request: Request):
    """Store a generated exam and return its ID."""
    body = await request.json()

    topic         = clean_text(body.get("topic", "General Knowledge"))
    questions     = body.get("questions", [])
    timer_m       = int(body.get("timer_minutes", 0))
    difficulty    = body.get("difficulty", "medium")
    mode          = body.get("mode", "practice")
    exam_format   = body.get("exam_format", "CBSE")
    question_type = body.get("question_type", "mcq")

    if not questions:
        return JSONResponse({"error": "No questions provided"}, status_code=400)

    exam_id = str(uuid.uuid4())
    EXAMS[exam_id] = {
        "id": exam_id,
        "created_at": int(time.time()),
        "title": f"Test: {topic[:40]}",
        "meta": {
            "difficulty": difficulty,
            "question_type": question_type,
            "include_answers": True,
            "timer_minutes": timer_m,
            "mode": mode,
            "exam_format": exam_format,
            "ai_generated": True,
        },
        "questions": questions,
        "submitted": False,
        "result": None,
    }
    return JSONResponse({"exam_id": exam_id})


# ─────────────────────────────────────────
# Get Exam API
# ─────────────────────────────────────────

@app.get("/api/exam/{exam_id}")
def api_get_exam(exam_id: str):
    """Return exam data for rendering the exam page."""
    exam = EXAMS.get(exam_id)
    if not exam:
        return JSONResponse({"error": "Exam not found"}, status_code=404)

    mode            = exam["meta"].get("mode", "practice")
    include_answers = exam["meta"].get("include_answers", True)

    questions_out = []
    for idx, q in enumerate(exam["questions"], start=1):
        base = {
            "id":   idx,
            "type": q.get("type", "mcq"),
            "q":    q.get("q", ""),
        }
        if q.get("type") == "written":
            base["marks"] = q.get("marks", 5)
            if mode == "practice" and include_answers:
                base["model_answer"] = q.get("model_answer", "")
                base["key_points"]   = q.get("key_points", [])
        else:
            base["options"] = q.get("options", [])
            if mode == "practice" and include_answers:
                base["answer"]  = q.get("answer", "")
                base["explain"] = q.get("explain", "")

        questions_out.append(base)

    return {
        "id":        exam["id"],
        "title":     exam["title"],
        "meta":      exam["meta"],
        "questions": questions_out,
        "submitted": exam["submitted"],
        "result":    exam["result"],
    }


# ─────────────────────────────────────────
# Submit Exam API
# ─────────────────────────────────────────

@app.post("/api/submit/{exam_id}")
async def api_submit_exam(exam_id: str, request: Request):
    """Score and submit a completed exam."""
    exam = EXAMS.get(exam_id)
    if not exam:
        return JSONResponse({"error": "Exam not found"}, status_code=404)

    payload   = await request.json()
    answers   = payload.get("answers", {})
    time_over = bool(payload.get("time_over", False))

    # Return existing result if already submitted
    if exam["submitted"]:
        return {"ok": True, "submitted": True, "result": exam["result"]}

    total_marks    = 0.0
    got_marks      = 0.0
    missing_points: List[str] = []
    feedback_lines: List[str] = []

    for idx, q in enumerate(exam["questions"], start=1):
        qid = str(idx)

        if q.get("type") == "written":
            marks       = float(q.get("marks", 5))
            total_marks += marks
            user_text   = str(answers.get(qid) or "")
            score_pct   = score_written_answer(user_text, q.get("key_points", []))
            got_marks  += round((score_pct / 100.0) * marks, 2)
            if score_pct < 50:
                missing_points.append(f"Q{idx} (Written): Cover more key concepts.")
        else:
            total_marks += 1
            user = (answers.get(qid) or "").strip().upper()
            if user == q.get("answer", ""):
                got_marks += 1
            else:
                correct_opt = next(
                    (o["text"] for o in q.get("options", []) if o["key"] == q.get("answer")),
                    q.get("answer", "?")
                )
                missing_points.append(
                    f"Q{idx}: Correct answer was {q.get('answer')}-{correct_opt}"
                )

    percent = 0.0 if total_marks == 0 else round((got_marks / total_marks) * 100, 2)
    grade   = grade_from_percent(percent)

    if percent < 50:
        feedback_lines.append("Focus on core concepts-revise this chapter thoroughly.")
    elif percent < 70:
        feedback_lines.append("Good start! Work on accuracy and cover all key points.")
    elif percent < 90:
        feedback_lines.append("Nice work! A bit more practice and you'll nail it.")
    else:
        feedback_lines.append("Excellent performance! You've got this chapter down.")

    if time_over:
        feedback_lines.append("Time ran out-answers were auto-submitted.")

    result = {
        "score":              f"{round(got_marks, 2)}/{round(total_marks, 2)}",
        "percentage":         percent,
        "grade":              grade,
        "feedback":           " ".join(feedback_lines),
        "missing_points":     missing_points[:8],
        "suggested_revision": [
            "Revise definitions and examples",
            "Practice application-based questions",
            "Write answers with proper structure (point-wise)",
        ],
        "answer_key": build_answer_key(exam),
    }

    exam["submitted"] = True
    exam["result"]    = result
    return {"ok": True, "submitted": True, "result": result}