import os

# Must be set before Paddle is imported (Windows oneDNN crash workaround).
os.environ["FLAGS_use_mkldnn"] = "0"
os.environ["PADDLE_PDX_DISABLE_MKLDNN"] = "1"
os.environ["FLAGS_onnxruntime_enabled"] = "0"

from pathlib import Path

from dotenv import load_dotenv
import uvicorn

load_dotenv(Path(__file__).resolve().parent / ".env")


if __name__ == "__main__":
    # 0.0.0.0 often hits WinError 10013 on Windows; default to localhost.
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8001"))
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port
    )
