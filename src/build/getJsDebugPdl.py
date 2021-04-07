import json
import os.path
import urllib.request

# To use this, download and copy pdl.py from here beside this file
# https://github.com/nodejs/node/blob/e31a99f01b8a92615ce79b845441949424cd1dda/tools/inspector_protocol/pdl.py
import pdl

with open(
    os.path.join(os.path.dirname(__file__), "..", "adapter", "cdpProxy.pdl")
) as r:
    pdl_contents = pdl.loads(r.read(), "node_protocol.pdl", True)
    with open(os.path.join(os.path.dirname(__file__), "jsDebugCustom.ts"), "w") as o:
        o.write("/*---------------------------------------------------------\n")
        o.write(" * Copyright (C) Microsoft Corporation. All rights reserved.\n")
        o.write(" *--------------------------------------------------------*/\n")
        o.write("\n")
        o.write("export default ")
        json.dump(pdl_contents, o, indent=2, separators=(",", ": "))
