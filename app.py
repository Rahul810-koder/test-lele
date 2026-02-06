from __future__ import annotations

import os
import re
import json
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, UploadFile, File, Form, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# Optional deps
PDF_OK = True
OCR_OK = True
FUZZ_OK = True

try:
    import pdfplumber  # type: ignore
except Exception:
    PDF_OK = False

try:
    from PIL import Image  # type: ignore
    import pytesseract  # type: ignore
except Exception:
    OCR_OK = False

try:
    from rapidfuzz import fuzz  # type: ignore
except Exception:
    FUZZ_OK = False


app = FastAPI(title="ExamGen (MVP+)", version="1.0.0")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")


# ----------------------------
# In-memory storage (swap later with DB)
# ----------------------------
@dataclass
class ExamSession:
    exam_id: str
    mode: str  # "practice" | "exam"
    meta: Dict[str, Any]
    paper: Dict[str, Any]


EXAMS: Dict[str, ExamSession] = {}


# ----------------------------
# Pages
# ----------------------------
@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/exam/{exam_id}", response_class=HTMLResponse)
def exam_page(request: Request, exam_id: str):
    if exam_id not in EXAMS:
        raise HTTPException(status_code=404, detail="Exam not found")
    return templates.TemplateResponse("exam.html", {"request": request, "exam_id": exam_id})


# ----------------------------
# Helpers: extraction
# ----------------------------
async def extract_text_from_pdf(file: UploadFile) -> str:
    if not PDF_OK:
        raise HTTPException(status_code=400, detail="PDF extraction not available. Install pdfplumber.")

    contents = await file.read()
    import io

    text_parts: List[str] = []
    with pdfplumber.open(io.BytesIO(contents)) as pdf:
        for page in pdf.pages:
            t = page.extract_text() or ""
            if t.strip():
                text_parts.append(t)

    extracted = "\n".join(text_parts).strip()
    if not extracted:
        raise HTTPException(status_code=400, detail="Could not extract text from PDF (maybe scanned).")
    return extracted


async def extract_text_from_image(file: UploadFile) -> str:
    if not OCR_OK:
        raise HTTPException(
            status_code=400,
            detail="Image OCR not available. Install pillow + pytesseract and Tesseract OCR in OS.",
        )

    contents = await file.read()
    import io

    img = Image.open(io.BytesIO(contents))
    text = (pytesseract.image_to_string(img) or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Could not OCR text from image (try clearer image).")
    return text


def normalize(s: str) -> str:
    s = (s or "").lower().strip()
    s = re.sub(r"\s+", " ", s)
    return s


# ----------------------------
# Generator (OpenAI optional + local fallback)
# ----------------------------
def openai_generate_exam(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    If OPENAI_API_KEY is set and OpenAI SDK exists, generate with model.
    Else return None (fallback).
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None

    try:
        from openai import OpenAI  # type: ignore
    except Exception:
        return None

    client = OpenAI(api_key=api_key)

    topic_text = payload["topic_text"]
    difficulty = payload["difficulty"]
    qtype = payload["qtype"]
    n_questions = payload["n_questions"]
    need_explanations = payload["need_explanations"]

    system = (
        "You are an AI Exam Generator, Evaluator, and Personal Tutor. "
        "Return ONLY valid JSON. No markdown, no extra text."
    )

    schema = {
        "title": "string",
        "instructions": ["string"],
        "sections": [
            {
                "name": "string",
                "questions": [
                    {
                        "id": "string",
                        "type": "mcq|written",
                        "difficulty": "easy|medium|hard",
                        "prompt": "string",
                        "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
                        "answer": "A|B|C|D OR model answer text",
                        "explanation": "string",
                        "key_points": ["string"],
                        "marks": 1,
                    }
                ],
            }
        ],
    }

    user = f"""
Generate an exam ONLY from this content/topic:

{topic_text}

Settings:
- difficulty: {difficulty}
- question_type: {qtype}
- number_of_questions: {n_questions}
- include_explanations: {need_explanations}

Rules:
- Balanced difficulty distribution.
- Include concept + application + reasoning.
- Real exam formatting.
- MCQ: 4 options A-D; answer must be only the letter A/B/C/D.
- Written: answer must be ideal model answer + key_points + marks.

Return JSON exactly matching this schema:
{json.dumps(schema, ensure_ascii=False)}
""".strip()

    try:
        resp = client.chat.completions.create(
            model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.6,
        )
        content = (resp.choices[0].message.content or "").strip()
        return json.loads(content)
    except Exception:
        return None


def local_fallback_exam(payload: Dict[str, Any]) -> Dict[str, Any]:
    topic = payload["topic_text"].strip()
    difficulty = payload["difficulty"]
    qtype = payload["qtype"]
    n = int(payload["n_questions"])
    need_explanations = bool(payload["need_explanations"])

    def diff_mix(i: int) -> str:
        if difficulty == "Easy":
            return "easy"
        if difficulty == "Medium":
            return "medium"
        if difficulty == "Hard":
            return "hard"
        return ["easy", "medium", "hard"][i % 3]  # Mixed

    def make_mcq(i: int) -> Dict[str, Any]:
        d = diff_mix(i)
        marks = 1 if d == "easy" else (2 if d == "medium" else 3)
        return {
            "id": f"Q{i+1}",
            "type": "mcq",
            "difficulty": d,
            "prompt": f"[{d.upper()}] {topic}: Choose the best answer (Q{i+1}).",
            "options": [
                "A. Statement that is most directly correct",
                "B. Statement that is partially correct",
                "C. Statement that is incorrect",
                "D. Not enough information from context",
            ],
            "answer": "A",
            "explanation": "A is the most directly correct option based on the topic context." if need_explanations else "",
            "key_points": [f"Core concept of {topic}", "Common traps", "Basic application"],
            "marks": marks,
        }

    def make_written(i: int) -> Dict[str, Any]:
        d = diff_mix(i)
        marks = 3 if d == "easy" else (5 if d == "medium" else 8)
        model = (
            f"Define {topic}, explain key mechanism/steps, give one real example, "
            f"and conclude with importance/limitations."
        )
        return {
            "id": f"Q{i+1}",
            "type": "written",
            "difficulty": d,
            "prompt": f"[{d.upper()}] Explain {topic} with an example (Q{i+1}).",
            "options": [],
            "answer": model,
            "explanation": "Use definition → explanation → example → conclusion." if need_explanations else "",
            "key_points": [
                f"Correct definition of {topic}",
                "Clear explanation",
                "Relevant example",
                "Correct terminology",
            ],
            "marks": marks,
        }

    if qtype == "MCQ":
        questions = [make_mcq(i) for i in range(n)]
    elif qtype == "Written":
        questions = [make_written(i) for i in range(n)]
    else:
        # Both -> half MCQ + half Written
        half = max(1, n // 2)

        mcqs = [make_mcq(i) for i in range(half)]

        written: List[Dict[str, Any]] = []
        for j in range(n - half):
            q = make_written(j)
            # IMPORTANT: continue ids after MCQ ids so NO DUPLICATE IDs
            q["id"] = f"Q{half + j + 1}"
            written.append(q)

        questions = mcqs + written

    paper = {
        "title": f"Test Paper: {topic[:60]}",
        "instructions": [
            "Answer all questions.",
            "Use clear reasoning and correct terminology.",
            "For written answers: definition → explanation → example.",
        ],
        "sections": [{"name": "Section A", "questions": questions}],
    }
    return paper


def ensure_unique_ids(paper: Dict[str, Any]) -> Dict[str, Any]:
    """
    Safety net: even if generator returns duplicate IDs, fix them.
    """
    seen = set()
    counter = 1

    for sec in paper.get("sections", []):
        for q in sec.get("questions", []):
            qid = str(q.get("id", "")).strip()
            if (not qid) or (qid in seen):
                qid = f"Q{counter}"
            while qid in seen:
                counter += 1
                qid = f"Q{counter}"
            q["id"] = qid
            seen.add(qid)
            counter += 1

    return paper


def generate_exam(payload: Dict[str, Any]) -> Dict[str, Any]:
    paper = openai_generate_exam(payload)
    if paper:
        return ensure_unique_ids(paper)
    return ensure_unique_ids(local_fallback_exam(payload))


# ----------------------------
# Evaluation & grading
# ----------------------------
def grade_bucket(pct: float) -> str:
    if pct <= 49:
        return "Needs Improvement"
    if pct <= 69:
        return "Not Bad"
    if pct <= 89:
        return "Good"
    if pct <= 98:
        return "Very Good"
    return "Excellent"


def score_written(student: str, key_points: List[str], marks: int) -> Tuple[float, List[str]]:
    st = normalize(student)
    if not st:
        return 0.0, key_points

    covered = 0
    missing: List[str] = []

    for kp in key_points:
        kp_norm = normalize(kp)
        if kp_norm and kp_norm in st:
            covered += 1
        else:
            if FUZZ_OK and kp_norm:
                if fuzz.partial_ratio(kp_norm, st) >= 78:
                    covered += 1
                else:
                    missing.append(kp)
            else:
                missing.append(kp)

    coverage_ratio = covered / max(1, len(key_points))

    # simple clarity bonus
    bonus = 0.0
    words = len(st.split())
    if words >= 35:
        bonus += 0.10
    if any(x in st for x in ["because", "therefore", "for example", "example"]):
        bonus += 0.05

    raw = min(1.0, coverage_ratio + bonus)
    return round(raw * marks, 2), missing


def evaluate_submission(paper: Dict[str, Any], student_answers: Dict[str, Any]) -> Dict[str, Any]:
    all_qs: List[Dict[str, Any]] = []
    for sec in paper.get("sections", []):
        all_qs.extend(sec.get("questions", []))

    total_marks = 0
    scored_marks = 0.0
    per_question: List[Dict[str, Any]] = []

    for q in all_qs:
        qid = q["id"]
        q_marks = int(q.get("marks", 1))
        total_marks += q_marks

        st_ans = student_answers.get(qid, "")
        qtype = q.get("type")

        if qtype == "mcq":
            correct = normalize(str(q.get("answer", "")))
            chosen = normalize(str(st_ans))
            got = float(q_marks) if chosen == correct else 0.0
            scored_marks += got
            per_question.append(
                {
                    "id": qid,
                    "type": "mcq",
                    "marks": q_marks,
                    "score": got,
                    "correct_answer": q.get("answer", ""),
                    "your_answer": st_ans,
                    "explanation": q.get("explanation", ""),
                    "status": "correct" if got == q_marks else "wrong",
                }
            )
        else:
            key_points = q.get("key_points", []) or []
            got, missing = score_written(str(st_ans), key_points, q_marks)
            scored_marks += got
            per_question.append(
                {
                    "id": qid,
                    "type": "written",
                    "marks": q_marks,
                    "score": got,
                    "model_answer": q.get("answer", ""),
                    "your_answer": st_ans,
                    "missing_points": missing,
                    "explanation": q.get("explanation", ""),
                }
            )

    pct = 0.0 if total_marks == 0 else round((scored_marks / total_marks) * 100, 2)

    improve: List[str] = []
    if pct < 70:
        improve.append("Revise core definitions and key terms.")
        improve.append("Practice more application-based questions.")
    if pct < 50:
        improve.append("Write structured answers: definition → explanation → example.")
    if pct >= 90:
        improve.append("Maintain consistency; add timed practice for exam readiness.")

    missing_accum: List[str] = []
    for pq in per_question:
        if pq["type"] == "written":
            missing_accum.extend(pq.get("missing_points", []))

    seen = set()
    weak_topics: List[str] = []
    for m in missing_accum:
        t = (m or "").strip()
        if t and t.lower() not in seen:
            weak_topics.append(t)
            seen.add(t.lower())

    return {
        "total_marks": total_marks,
        "scored_marks": round(scored_marks, 2),
        "percentage": pct,
        "grade": grade_bucket(pct),
        "feedback": {
            "summary": "Focus on missing concepts and improve answer structure.",
            "how_to_improve": improve,
            "suggested_revision_topics": weak_topics[:10],
        },
        "per_question": per_question,
    }


# ----------------------------
# API
# ----------------------------
@app.post("/api/generate")
async def api_generate(
    topic_text: str = Form(""),
    difficulty: str = Form(...),     # Easy/Medium/Hard/Mixed
    qtype: str = Form(...),          # MCQ/Written/Both
    n_questions: int = Form(...),
    need_explanations: str = Form("yes"),
    mode: str = Form("practice"),    # practice/exam
    timer_minutes: int = Form(0),    # NEW: timer
    file: Optional[UploadFile] = File(None),
):
    extracted_summary = ""
    final_text = (topic_text or "").strip()

    if file is not None:
        filename = (file.filename or "").lower()
        if filename.endswith(".pdf"):
            extracted = await extract_text_from_pdf(file)
            extracted_summary = extracted[:800].strip()
            final_text = extracted
        elif filename.endswith((".png", ".jpg", ".jpeg", ".webp")):
            extracted = await extract_text_from_image(file)
            extracted_summary = extracted[:800].strip()
            final_text = extracted
        else:
            raise HTTPException(status_code=400, detail="Unsupported file type. Upload PDF or image.")

    if not final_text:
        raise HTTPException(status_code=400, detail="Please provide topic text/notes or upload a PDF/image.")

    if difficulty not in ["Easy", "Medium", "Hard", "Mixed"]:
        raise HTTPException(status_code=400, detail="Invalid difficulty.")
    if qtype not in ["MCQ", "Written", "Both"]:
        raise HTTPException(status_code=400, detail="Invalid question type.")
    if mode not in ["practice", "exam"]:
        raise HTTPException(status_code=400, detail="Invalid mode.")
    if n_questions < 1 or n_questions > 60:
        raise HTTPException(status_code=400, detail="Number of questions must be 1–60.")
    if timer_minutes < 0 or timer_minutes > 300:
        raise HTTPException(status_code=400, detail="Timer minutes must be 0–300.")

    payload = {
        "topic_text": final_text,
        "difficulty": difficulty,
        "qtype": qtype,
        "n_questions": n_questions,
        "need_explanations": (need_explanations.lower() == "yes"),
        "mode": mode,
    }

    paper = generate_exam(payload)

    exam_id = str(uuid.uuid4())
    EXAMS[exam_id] = ExamSession(
        exam_id=exam_id,
        mode=mode,
        meta={
            "difficulty": difficulty,
            "qtype": qtype,
            "n_questions": n_questions,
            "need_explanations": payload["need_explanations"],
            "extracted_summary": extracted_summary,
            "timer_minutes": timer_minutes,  # NEW
        },
        paper=paper,
    )

    return {
        "exam_id": exam_id,
        "redirect_url": f"/exam/{exam_id}",
        "extracted_summary": extracted_summary,
    }


@app.get("/api/exam/{exam_id}")
def api_get_exam(exam_id: str):
    if exam_id not in EXAMS:
        raise HTTPException(status_code=404, detail="Exam not found")
    sess = EXAMS[exam_id]
    return {"exam_id": exam_id, "mode": sess.mode, "meta": sess.meta, "paper": sess.paper}

@app.get("/ping")
def ping():
    return {"ok": True}


@app.post("/api/submit/{exam_id}")
async def api_submit(exam_id: str, request: Request):
    if exam_id not in EXAMS:
        raise HTTPException(status_code=404, detail="Exam not found")
    sess = EXAMS[exam_id]

    body = await request.json()
    student_answers = body.get("answers", {})
    if not isinstance(student_answers, dict):
        raise HTTPException(status_code=400, detail="Invalid answers payload.")

    result = evaluate_submission(sess.paper, student_answers)

    return {"exam_id": exam_id, "mode": sess.mode, "result": result, "paper": sess.paper}
