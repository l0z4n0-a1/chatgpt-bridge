"""
Multimodal usage via your ChatGPT subscription.

Three patterns, each ~10 lines:
  1. Vision  — ask a question about a local image
  2. File context — ask a question grounded in a local text file
  3. Reference image — generate an image guided by a moodboard

Prereq: chatgpt-bridge serve   (running on :10531)
        npx @openai/codex login (one-time)
"""

import base64
from pathlib import Path
from openai import OpenAI

c = OpenAI(base_url="http://127.0.0.1:10531/v1", api_key="unused")


# 1) VISION — image as part of the conversation
#    OpenAI-standard shape; portable to api.openai.com.
def vision(image_path: str, question: str) -> str:
    b64 = base64.b64encode(Path(image_path).read_bytes()).decode()
    resp = c.chat.completions.create(
        model="gpt-5.2",
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": question},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ],
        }],
    )
    return resp.choices[0].message.content


# 2) FILE CONTEXT — bridge extension: {type:"input_file", file:{path|url|data,mime}}
#    Not portable to api.openai.com. The bridge resolves `path` server-side.
def file_context(file_path: str, question: str) -> str:
    resp = c.chat.completions.create(
        model="gpt-5.2",
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": question},
                {"type": "input_file", "file": {"path": file_path}},
            ],
        }],
    )
    return resp.choices[0].message.content


# 3) REFERENCE IMAGE — bridge extension: `reference_images[]` on /v1/images/generations
#    Up to 8 refs. Drives style / composition / palette.
def image_with_reference(prompt: str, refs: list[str], out: str) -> str:
    img = c.images.generate(
        model="gpt-image-2",
        prompt=prompt,
        size="1024x1024",
        quality="high",
        extra_body={"reference_images": refs},
    )
    Path(out).write_bytes(base64.b64decode(img.data[0].b64_json))
    return out


if __name__ == "__main__":
    # Replace these paths with files you have locally before running.
    print("vision:", vision("./screenshot.png", "What font is this? One word."))
    print("file:  ", file_context("./README.md", "Summarize in one sentence."))
    print("image: ", image_with_reference(
        "hero shot, brand-consistent, premium aesthetic",
        ["./moodboard.png", "./logo.svg"],
        "./hero.png",
    ))
