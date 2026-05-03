"""
Generate an image via your ChatGPT subscription.
Prereq: chatgpt-bridge serve  (running on :10531)
"""

import base64
from openai import OpenAI

c = OpenAI(base_url="http://127.0.0.1:10531/v1", api_key="unused")

img = c.images.generate(
    model="gpt-image-2",
    prompt="a small red fox under an oak tree, watercolor",
    size="1024x1024",
    quality="high",
)

with open("fox.png", "wb") as f:
    f.write(base64.b64decode(img.data[0].b64_json))

print("saved fox.png")
