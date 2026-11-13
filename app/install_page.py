"""Public installation material only; never expose a directory or runtime configuration."""
from pathlib import Path

from fastapi import APIRouter
from starlette.responses import FileResponse, Response

WEB = Path(__file__).resolve().parents[1] / "web"
PUBLIC_PATHS = frozenset({
    "/install", "/install/", "/install/azuredeploy.json", "/install/bootstrap.ps1",
})
router = APIRouter(include_in_schema=False)
TEMPLATE_HEADERS = {
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


@router.get("/install")
@router.get("/install/")
async def install_page() -> FileResponse:
    return FileResponse(WEB / "install.html", media_type="text/html",
                        headers={"Cache-Control": "no-cache"})


@router.api_route("/install/azuredeploy.json", methods=["GET", "HEAD"])
async def install_template() -> FileResponse:
    return FileResponse(WEB / "install" / "azuredeploy.json", media_type="application/json",
                        headers=TEMPLATE_HEADERS)


@router.options("/install/azuredeploy.json")
async def install_template_preflight() -> Response:
    return Response(status_code=204, headers=TEMPLATE_HEADERS)


@router.get("/install/bootstrap.ps1")
async def install_bootstrap() -> FileResponse:
    return FileResponse(WEB / "install" / "bootstrap.ps1", media_type="text/plain",
                        headers={"Cache-Control": "no-cache"})
