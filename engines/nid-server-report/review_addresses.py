"""Format each Server Copy review address with the NID engine composer."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


_nid_fields_path = Path(__file__).resolve().parents[1] / "nid-replica" / "make_fields.py"
_nid_fields_spec = spec_from_file_location("nid_replica_make_fields", _nid_fields_path)
_nid_fields = module_from_spec(_nid_fields_spec)
_nid_fields_spec.loader.exec_module(_nid_fields)
_EMPTY_PARTS = {"", "-", "--", "—", "–", "n/a", "na", "none", "null", "না", "০"}


def review_addresses(data):
    result = {}
    for key in ("Present Address", "Permanent Address"):
        source = data.get(key)
        if not source:
            result[key] = ""
            continue

        # Global location fields refer to the current address only.
        context = data if key == "Present Address" else {}
        if isinstance(source, dict):
            parts = {
                name: str(value).strip() for name, value in source.items()
                if value is not None and str(value).strip().lower() not in _EMPTY_PARTS
            }
            if not parts:
                result[key] = ""
                continue
            # Some report PDFs have a named city but no RMO row.
            if (not (parts.get("rmo") or context.get("RMO")) and
                    any(parts.get(name) for name in ("city_corp", "city_corp2", "city_corp3"))):
                parts["rmo"] = "শহর"
            address = _nid_fields.compose_address(parts, context)
            # Keep the separate ward/union value available on a Server
            # Copy when the NID card's address line omits it.
            ward = parts.get("union_ward") or parts.get("ward_porishod")
            ward = _nid_fields.compose_address(ward) if ward else ""
            if ward and ward not in address.split(", "):
                address = ", ".join(filter(None, (address, "ইউনিয়ন/ওয়ার্ড: " + ward)))
        elif isinstance(source, str):
            address = "" if source.strip().lower() in _EMPTY_PARTS else _nid_fields.compose_address(source)
        else:
            address = ""
        result[key] = address
    return result
