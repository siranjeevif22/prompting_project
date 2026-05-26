import os
import json
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def read_file(filename):
    with open(os.path.join(BASE_DIR, filename), "r", encoding="utf-8") as f:
        return f.read()

def read_json(filename):
    with open(os.path.join(BASE_DIR, filename), "r", encoding="utf-8") as f:
        data = json.load(f)
    return json.dumps(data, indent=2, ensure_ascii=False)

data = "Soumya Swarup Das_call_transcript"
evaluator_prompt = read_file("evaluator.txt")
interview_system_prompt = read_file("prompt.txt")
transcript = read_json(f"{data}.json")

filled_prompt = (
    evaluator_prompt
    .replace("{{SYSTEM_PROMPT}}", interview_system_prompt)
    .replace("{{TRANSCRIPT}}", transcript)
)

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

MODEL_NAME = "gemini-2.5-flash"

config = types.GenerateContentConfig(
    temperature=0.3,
    max_output_tokens=16000,
    thinking_config=types.ThinkingConfig(thinking_budget=0),
    system_instruction=filled_prompt,
)

contents = [
    types.Content(
        role="user",
        parts=[types.Part.from_text(text="Evaluate the transcript against the system prompt and list all violations.")]
    )
]

result_chunks = []
usage = None

for chunk in client.models.generate_content_stream(
    model=MODEL_NAME,
    contents=contents,
    config=config,
):
    if chunk.text:
        print(chunk.text, end="", flush=True)
        result_chunks.append(chunk.text)
    if chunk.usage_metadata:
        usage = chunk.usage_metadata

print()
if usage:
    print(f"\n--- Tokens: input={usage.prompt_token_count} | output={usage.candidates_token_count} | total={usage.total_token_count} ---")

result = "".join(result_chunks)

output_path = os.path.join(BASE_DIR, f"{data}.txt")
with open(output_path, "w", encoding="utf-8") as f:
    f.write(result)

print(f"\n--- Saved to {output_path} ---")
