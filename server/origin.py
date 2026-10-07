def is_extension_allowed(origin: str, allowed_ids: list[str], allow_any_origin: bool) -> bool:
    if allow_any_origin:
        return True
    prefix = "chrome-extension://"
    if not origin.startswith(prefix):
        return False
    extension_id = origin.removeprefix(prefix).rstrip("/")
    return bool(allowed_ids) and extension_id in allowed_ids
