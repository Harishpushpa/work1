from fastapi import FastAPI

from app.api.routes import router

app = FastAPI(title="Insurance FAQ generator")
app.include_router(router)
