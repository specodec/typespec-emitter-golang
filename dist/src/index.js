import { emitFile, listServices, navigateTypesInNamespace, } from "@typespec/compiler";
function extractFields(model) {
    const fields = [];
    for (const [name, prop] of model.properties) {
        fields.push({ name, type: prop.type, optional: prop.optional ?? false });
    }
    return fields;
}
function snake(s) {
    return s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
}
function goExport(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
function scalarName(type) {
    if (type.kind === "Scalar")
        return type.name;
    return "";
}
function typeToGo(type, optional = false) {
    const n = scalarName(type);
    let base = "";
    if (n === "string")
        base = "string";
    else if (n === "boolean")
        base = "bool";
    else if (n === "int8")
        base = "int8";
    else if (n === "int16")
        base = "int16";
    else if (n === "int32" || n === "integer")
        base = "int32";
    else if (n === "int64")
        base = "int64";
    else if (n === "uint8")
        base = "uint8";
    else if (n === "uint16")
        base = "uint16";
    else if (n === "uint32")
        base = "uint32";
    else if (n === "uint64")
        base = "uint64";
    else if (n === "float32")
        base = "float32";
    else if (n === "float64" || n === "float" || n === "decimal")
        base = "float64";
    else if (n === "bytes")
        base = "[]byte";
    else if (type.kind === "Model" && type.indexer)
        base = `[]${typeToGo(type.indexer.value)}`;
    else if (type.kind === "Model" && type.name)
        base = type.name;
    else
        base = "interface{}";
    return optional && base !== "[]byte" && !base.startsWith("[]") ? `*${base}` : base;
}
function writeJsonExpr(type, varExpr) {
    const n = scalarName(type);
    if (n === "string")
        return `w.WriteString(${varExpr})`;
    if (n === "boolean")
        return `w.WriteBool(${varExpr})`;
    if (n === "int8" || n === "int16" || n === "int32" || n === "integer")
        return `w.WriteInt32(int32(${varExpr}))`;
    if (n === "int64")
        return `w.WriteInt64(${varExpr})`;
    if (n === "uint8" || n === "uint16" || n === "uint32")
        return `w.WriteUint32(uint32(${varExpr}))`;
    if (n === "uint64")
        return `w.WriteUint64(${varExpr})`;
    if (n === "float32")
        return `w.WriteFloat32(${varExpr})`;
    if (n === "float64" || n === "float" || n === "decimal")
        return `w.WriteFloat64(${varExpr})`;
    if (n === "bytes")
        return `w.WriteBytes(${varExpr})`;
    if (type.kind === "Model" && type.indexer) {
        const elem = type.indexer.value;
        return `func() { w.BeginArray(len(${varExpr})); for _, _e := range ${varExpr} { w.NextElement(); ${writeJsonExpr(elem, "_e")} } w.EndArray() }()`;
    }
    if (type.kind === "Model" && type.name)
        return `Write${type.name}Json(w, ${varExpr})`;
    return `w.WriteString(fmt.Sprint(${varExpr}))`;
}
function writeMsgPackExpr(type, varExpr) {
    const n = scalarName(type);
    if (n === "string")
        return `w.WriteString(${varExpr})`;
    if (n === "boolean")
        return `w.WriteBool(${varExpr})`;
    if (n === "int8" || n === "int16" || n === "int32" || n === "integer")
        return `w.WriteInt32(int32(${varExpr}))`;
    if (n === "int64")
        return `w.WriteInt64(${varExpr})`;
    if (n === "uint8" || n === "uint16" || n === "uint32")
        return `w.WriteUint32(uint32(${varExpr}))`;
    if (n === "uint64")
        return `w.WriteUint64(${varExpr})`;
    if (n === "float32")
        return `w.WriteFloat32(${varExpr})`;
    if (n === "float64" || n === "float" || n === "decimal")
        return `w.WriteFloat64(${varExpr})`;
    if (n === "bytes")
        return `w.WriteBytes(${varExpr})`;
    if (type.kind === "Model" && type.indexer) {
        const elem = type.indexer.value;
        return `func() { w.BeginArray(len(${varExpr})); for _, _e := range ${varExpr} { w.NextElement(); ${writeMsgPackExpr(elem, "_e")} } w.EndArray() }()`;
    }
    if (type.kind === "Model" && type.name)
        return `Write${type.name}MsgPack(w, ${varExpr})`;
    return `w.WriteString(fmt.Sprint(${varExpr}))`;
}
function readExpr(type) {
    const n = scalarName(type);
    if (n === "string")
        return `r.ReadString()`;
    if (n === "boolean")
        return `r.ReadBool()`;
    if (n === "int8")
        return `int8(r.ReadInt32())`;
    if (n === "int16")
        return `int16(r.ReadInt32())`;
    if (n === "int32" || n === "integer")
        return `r.ReadInt32()`;
    if (n === "int64")
        return `r.ReadInt64()`;
    if (n === "uint8")
        return `uint8(r.ReadUint32())`;
    if (n === "uint16")
        return `uint16(r.ReadUint32())`;
    if (n === "uint32")
        return `r.ReadUint32()`;
    if (n === "uint64")
        return `r.ReadUint64()`;
    if (n === "float32")
        return `r.ReadFloat32()`;
    if (n === "float64" || n === "float" || n === "decimal")
        return `r.ReadFloat64()`;
    if (n === "bytes")
        return `r.ReadBytes()`;
    if (type.kind === "Model" && type.indexer) {
        const elem = type.indexer.value;
        const elemGo = typeToGo(elem);
        return `func() []${elemGo} { var _a []${elemGo}; r.BeginArray(); for r.HasNextElement() { _a = append(_a, ${readExpr(elem)}) }; r.EndArray(); return _a }()`;
    }
    if (type.kind === "Model" && type.name)
        return `Decode${type.name}(r)`;
    return `r.ReadString()`;
}
function collectServices(program) {
    const services = listServices(program);
    const result = [];
    function collectFromNs(ns) {
        for (const [, iface] of ns.interfaces) {
            const models = [];
            const seen = new Set();
            navigateTypesInNamespace(ns, {
                model: (m) => {
                    if (m.name && !seen.has(m.name)) {
                        models.push(m);
                        seen.add(m.name);
                    }
                },
            });
            result.push({ namespace: ns, iface, serviceName: iface.name, models });
        }
    }
    for (const svc of services)
        collectFromNs(svc.type);
    if (result.length === 0) {
        const globalNs = program.getGlobalNamespaceType();
        for (const [, ns] of globalNs.namespaces)
            collectFromNs(ns);
        collectFromNs(globalNs);
    }
    return result;
}
export async function $onEmit(context) {
    const program = context.program;
    const outputDir = context.emitterOutputDir;
    const services = collectServices(program);
    for (const svc of services) {
        const pkg = `specodec_${snake(svc.namespace.name?.toLowerCase() ?? "svc")}`;
        const L = [];
        L.push("// Generated by @specodec/typespec-specodec-go. DO NOT EDIT.");
        L.push(`package ${pkg}`);
        L.push("");
        L.push(`import specodec "github.com/specodec/specodec-go"`);
        L.push("");
        for (const m of svc.models) {
            if (!m.name)
                continue;
            const fields = extractFields(m);
            // struct
            L.push(`type ${m.name} struct {`);
            for (const f of fields) {
                const goField = goExport(f.name);
                const goType = typeToGo(f.type, f.optional);
                const tag = `\`json:"${f.name}${f.optional ? ",omitempty" : ""}"\``;
                L.push(`\t${goField} ${goType} ${tag}`);
            }
            L.push("}");
            L.push("");
            // SpecCodec var
            L.push(`var ${m.name}Codec = specodec.SpecCodec[${m.name}]{`);
            // EncodeJson
            L.push(`\tEncodeJson: func(obj *${m.name}) []byte {`);
            L.push(`\t\tw := specodec.NewJsonWriter()`);
            L.push(`\t\tw.BeginObject()`);
            for (const f of fields) {
                const goField = goExport(f.name);
                const val = f.optional ? `*obj.${goField}` : `obj.${goField}`;
                if (f.optional) {
                    L.push(`\t\tif obj.${goField} != nil { w.WriteField("${f.name}"); ${writeJsonExpr(f.type, val)} }`);
                }
                else {
                    L.push(`\t\tw.WriteField("${f.name}"); ${writeJsonExpr(f.type, val)}`);
                }
            }
            L.push(`\t\tw.EndObject()`);
            L.push(`\t\treturn w.ToBytes()`);
            L.push(`\t},`);
            // EncodeMsgPack
            L.push(`\tEncodeMsgPack: func(obj *${m.name}) []byte {`);
            const required = fields.filter(f => !f.optional);
            const optional = fields.filter(f => f.optional);
            if (optional.length === 0) {
                L.push(`\t\tw := specodec.NewMsgPackWriter()`);
                L.push(`\t\tw.BeginObject(${fields.length})`);
            }
            else {
                L.push(`\t\t_n := ${required.length}`);
                for (const f of optional) {
                    L.push(`\t\tif obj.${goExport(f.name)} != nil { _n++ }`);
                }
                L.push(`\t\tw := specodec.NewMsgPackWriter()`);
                L.push(`\t\tw.BeginObject(_n)`);
            }
            for (const f of fields) {
                const goField = goExport(f.name);
                const val = f.optional ? `*obj.${goField}` : `obj.${goField}`;
                if (f.optional) {
                    L.push(`\t\tif obj.${goField} != nil { w.WriteField("${f.name}"); ${writeMsgPackExpr(f.type, val)} }`);
                }
                else {
                    L.push(`\t\tw.WriteField("${f.name}"); ${writeMsgPackExpr(f.type, val)}`);
                }
            }
            L.push(`\t\tw.EndObject()`);
            L.push(`\t\treturn w.ToBytes()`);
            L.push(`\t},`);
            // Decode
            L.push(`\tDecode: func(r specodec.SpecReader) *${m.name} {`);
            L.push(`\t\tobj := &${m.name}{}`);
            L.push(`\t\tr.BeginObject()`);
            L.push(`\t\tfor r.HasNextField() {`);
            L.push(`\t\t\tswitch r.ReadFieldName() {`);
            for (const f of fields) {
                const goField = goExport(f.name);
                const goType = typeToGo(f.type);
                if (f.optional) {
                    L.push(`\t\t\tcase "${f.name}": _v := ${readExpr(f.type)}; obj.${goField} = &_v`);
                }
                else {
                    L.push(`\t\t\tcase "${f.name}": obj.${goField} = ${readExpr(f.type)}`);
                }
            }
            L.push(`\t\t\tdefault: r.Skip()`);
            L.push(`\t\t\t}`);
            L.push(`\t\t}`);
            L.push(`\t\tr.EndObject()`);
            L.push(`\t\treturn obj`);
            L.push(`\t},`);
            L.push(`}`);
            L.push("");
        }
        const fileName = `${snake(svc.serviceName)}_types.go`;
        await emitFile(program, { path: `${outputDir}/${fileName}`, content: L.join("\n") });
    }
}
