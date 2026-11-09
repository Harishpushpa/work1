from typing import Any, Dict, List, Optional
from pydantic import BaseModel


class ElementResponse(BaseModel):
    type: str
    text: str
    page_number: Optional[int] = None
    element_id: Optional[str] = None
    metadata: Dict[str, Any] = {}


class DocumentResponse(BaseModel):
    success: bool
    document: Dict[str, Any]
    elements: List[ElementResponse]
    error: Optional[str] = None