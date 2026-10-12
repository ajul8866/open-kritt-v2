import re

from ..generation import GenerationValidationError, parse_refs

BATCH_KEY = re.compile(r"^multi_output_depth_\d+$")


class HandoffValidationError(GenerationValidationError):
    """A schema-valid workflow does not deliver the data consumed by its steps."""


def handoff_contracts(workflow):
    contracts = []
    available = set()
    previous = None
    for level in sorted(workflow["levels"], key=lambda item: item["depth"]):
        depth = level["depth"]
        if previous is not None:
            if level["consumesAll"]:
                key = f"multi_output_depth_{depth - 1}"
                available = {item for item in available if BATCH_KEY.fullmatch(item)} | {key}
                immediate = {key}
            else:
                immediate = set(previous["outputFormat"])
            for index, step in enumerate(level["steps"]):
                refs = set(parse_refs(step["content"]))
                mentioned = {
                    key
                    for key in available
                    if re.search(r"(?<![A-Za-z0-9_])" + re.escape(key) + r"(?![A-Za-z0-9_])", step["content"])
                }
                contracts.append(
                    {
                        "depth": depth,
                        "step_index": index,
                        "step_name": step["name"],
                        "previous_inputs": sorted(immediate),
                        "references_previous_input": bool(refs & immediate),
                        "missing_named_inputs": sorted(mentioned - refs),
                    }
                )
        available.update(level["outputFormat"])
        previous = level
    return contracts


def validate_handoffs(workflow):
    errors = []
    for contract in handoff_contracts(workflow):
        field = f"levels[depth={contract['depth']}].steps[{contract['step_index']}].content"
        if not contract["references_previous_input"]:
            options = ", ".join("{{" + key + "}}" for key in contract["previous_inputs"])
            errors.append(
                {
                    "field": field,
                    "message": f"Step {contract['step_name']!r} does not interpolate previous-depth data. Use input placeholders such as {options}. Naming fields alone does not deliver their values.",
                }
            )
        if contract["missing_named_inputs"]:
            names = ", ".join("{{" + key + "}}" for key in contract["missing_named_inputs"])
            errors.append({"field": field, "message": f"Named upstream inputs have no value placeholders: {names}."})
    if errors:
        raise HandoffValidationError(errors)
    return workflow
