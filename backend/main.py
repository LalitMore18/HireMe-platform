import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from groq import AsyncGroq
from pydantic import BaseModel
from pypdf import PdfReader

load_dotenv()

client = AsyncGroq(api_key=os.getenv("GROQ_API_KEY"))
model = "openai/gpt-oss-120b"

RESUME_PATH = Path(__file__).parent / "my_resume.pdf"

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class Experience(BaseModel):
    company: str | None = None
    role: str | None = None
    duration: str | None = None
    description: str | None = None
    skills_used: list[str] = []


class Resume(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    total_experience_years: float | None = None
    skills: list[str] = []
    experiences: list[Experience] = []
    education: list[str] = []
    projects: list[str] = []
    certifications: list[str] = []


resume_schema = Resume.model_json_schema()


class ChatRequest(BaseModel):
    question: str


# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------

cached_resume: Resume | None = None


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------

def read_pdf(file_path: Path) -> str:
    """Synchronous PDF text extraction — run via asyncio.to_thread."""
    reader = PdfReader(file_path)
    text = ""
    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text += page_text + "\n"
    return text


async def parse_resume(resume_text: str) -> Resume:
    system_prompt = f"""
    You are an expert resume parser.

    Extract information from the resume based on its meaning,
    not only based on exact section headings.

    Different resumes may use different headings like:
    Experience, Professional Experience, Work History, Employment, Internships.

    Return ONLY valid JSON matching this schema:
    {resume_schema}

    Important rules:
    1. Do not invent information.
    2. If a value is not available, return null.
    3. If a list has no information, return an empty list.
    4. Include internships inside experiences.
    5. Extract skills mentioned across the entire resume.
    """

    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Parse the following resume:\n\n{resume_text}"},
        ],
        response_format={"type": "json_object"},
    )
    data = json.loads(response.choices[0].message.content)
    return Resume(**data)


async def stream_answer(question: str, resume: Resume):
    """Async generator that yields SSE-formatted tokens from the LLM."""
    system_prompt = f"""
You are an AI assistant representing a job candidate.

Below is everything you know about the candidate:

{resume.model_dump_json(indent=2)}

Rules:
1. Answer only using this information.
2. Never hallucinate.
3. If information is unavailable, say "I don't have enough information to answer that."
4. Be professional.
5. Answer as if HR is interviewing this candidate.
"""
    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ],
        stream=True,
    )
    async for chunk in response:
        token = chunk.choices[0].delta.content
        if token:
            # Escape the token to keep SSE safe
            yield f"data: {json.dumps(token)}\n\n"

    yield "data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# App lifespan — parse resume at startup (properly awaited)
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global cached_resume
    if RESUME_PATH.exists():
        print("📄 Parsing resume on startup…")
        resume_text = await asyncio.to_thread(read_pdf, RESUME_PATH)
        cached_resume = await parse_resume(resume_text)
        print(f"✅ Resume ready: {cached_resume.name or 'Unknown'}")
    else:
        print("⚠️  No resume found. Place my_resume.pdf in the backend folder.")
    yield
    print("👋 Shutting down.")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="HireMe", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/")
def home():
    return RedirectResponse(url="/app/")


@app.get("/candidate")
def get_candidate():
    if cached_resume is None:
        raise HTTPException(status_code=503, detail="Resume is still being parsed. Try again in a moment.")
    return cached_resume


@app.post("/chat")
async def chat(request: ChatRequest):
    if cached_resume is None:
        raise HTTPException(status_code=503, detail="Resume is still being parsed. Try again in a moment.")

    return StreamingResponse(
        stream_answer(request.question, cached_resume),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Serve frontend
# ---------------------------------------------------------------------------

frontend_path = Path(__file__).parent.parent / "frontend"
if frontend_path.exists():
    app.mount("/app", StaticFiles(directory=str(frontend_path), html=True), name="frontend")
