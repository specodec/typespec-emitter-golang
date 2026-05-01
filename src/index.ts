import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
  Diagnostic,
} from "@typespec/compiler";
import {
  checkReservedKeyword,
  formatReservedError,
} from "@specodec/typespec-specodec-core";

export type EmitterOptions = {
  "emitter-output-dir": string;
  "ignore-reserved-keywords"?: boolean;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

interface ServiceInfo {
  namespace: Namespace;
  iface: Interface;
  serviceName: string;
  models: Model[];
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

function snake(s: string): string {
  return s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
}

function goExport(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function scalarName(type: Type): string {
  if (type.kind === "Scalar") return (type as Scalar).name;
  return "";
}

function isArray(type: Type): boolean {
  if (type.kind !== "Model" || !(type as Model).indexer) return false;
  const keyName = ((type as Model).indexer!.key as any).name;
  return keyName === "integer";
}

function isRecord(type: Type): boolean {
  if (type.kind !== "Model" || !(type as Model).indexer) return false;
  const keyName = ((type as Model).indexer!.key as any).name;
  return keyName === "string";
}

function arrayElem(type: Type): Type {
  return (type as Model).indexer!.value;
}

function recordElem(type: Type): Type {
  return (type as Model).indexer!.value;
}

function typeToGo(type: Type, optional: boolean = false): string {
  const n = scalarName(type);
  let base = "";
  if (n === "string") base = "string";
  else if (n === "boolean") base = "bool";
  else if (n === "int8") base = "int8";
  else if (n === "int16") base = "int16";
  else if (n === "int32" || n === "integer") base = "int32";
  else if (n === "int64") base = "int64";
  else if (n === "uint8") base = "uint8";
  else if (n === "uint16") base = "uint16";
  else if (n === "uint32") base = "uint32";
  else if (n === "uint64") base = "uint64";
  else if (n === "float32") base = "float32";
  else if (n === "float64" || n === "float" || n === "decimal") base = "float64";
  else if (n === "bytes") base = "[]byte";
  else if (isArray(type)) base = `[]${typeToGo(arrayElem(type))}`;
  else if (isRecord(type)) base = `map[string]${typeToGo(recordElem(type))}`;
  else if (type.kind === "Model" && type.name) base = type.name;
  else base = "interface{}";
  if (optional && base !== "[]byte" && !base.startsWith("[]") && !base.startsWith("map[")) return `*${base}`;
  return base;
}

// Single format-agnostic write expression using SpecWriter
function writeExpr(type: Type, varExpr: string): string {
  const n = scalarName(type);
  if (n === "string") return `w.WriteString(${varExpr})`;
  if (n === "boolean") return `w.WriteBool(${varExpr})`;
  if (n === "int8" || n === "int16" || n === "int32" || n === "integer") return `w.WriteInt32(int32(${varExpr}))`;
  if (n === "int64") return `w.WriteInt64(${varExpr})`;
  if (n === "uint8" || n === "uint16" || n === "uint32") return `w.WriteUint32(uint32(${varExpr}))`;
  if (n === "uint64") return `w.WriteUint64(${varExpr})`;
  if (n === "float32") return `w.WriteFloat32(${varExpr})`;
  if (n === "float64" || n === "float" || n === "decimal") return `w.WriteFloat64(${varExpr})`;
  if (n === "bytes") return `w.WriteBytes(${varExpr})`;
  if (isArray(type)) {
    const elem = arrayElem(type);
    const elemExpr = isModelType(elem) ? "&_e" : "_e";
    return `func() { w.BeginArray(len(${varExpr})); for _, _e := range ${varExpr} { w.NextElement(); ${writeExpr(elem, elemExpr)} }; w.EndArray() }()`;
  }
  if (isRecord(type)) {
    const elem = recordElem(type);
    const elemExpr = isModelType(elem) ? "&_v" : "_v";
    return `func() { w.BeginObject(len(${varExpr})); for _k, _v := range ${varExpr} { w.WriteField(_k); ${writeExpr(elem, elemExpr)} }; w.EndObject() }()`;
  }
  if (type.kind === "Model" && type.name) return `write${type.name}(w, ${varExpr})`;
  return `w.WriteString(fmt.Sprint(${varExpr}))`;
}

function readExpr(type: Type, optional?: boolean): string {
  const n = scalarName(type);
  if (n === "string") return `r.ReadString()`;
  if (n === "boolean") return `r.ReadBool()`;
  if (n === "int8") return `int8(r.ReadInt32())`;
  if (n === "int16") return `int16(r.ReadInt32())`;
  if (n === "int32" || n === "integer") return `r.ReadInt32()`;
  if (n === "int64") return `r.ReadInt64()`;
  if (n === "uint8") return `uint8(r.ReadUint32())`;
  if (n === "uint16") return `uint16(r.ReadUint32())`;
  if (n === "uint32") return `r.ReadUint32()`;
  if (n === "uint64") return `r.ReadUint64()`;
  if (n === "float32") return `r.ReadFloat32()`;
  if (n === "float64" || n === "float" || n === "decimal") return `r.ReadFloat64()`;
  if (n === "bytes") return `r.ReadBytes()`;
  if (isArray(type)) {
    const elem = arrayElem(type);
    const elemGo = typeToGo(elem);
    const elemRead = isModelType(elem) ? `*${readExpr(elem)}` : readExpr(elem);
    return `func() []${elemGo} { var _a []${elemGo}; r.BeginArray(); for r.HasNextElement() { _a = append(_a, ${elemRead}) }; r.EndArray(); return _a }()`;
  }
  if (isRecord(type)) {
    const elem = recordElem(type);
    const elemGo = typeToGo(elem);
    const elemRead = isModelType(elem) ? `*${readExpr(elem)}` : readExpr(elem);
    return `func() map[string]${elemGo} { var _m map[string]${elemGo}; r.BeginObject(); for r.HasNextField() { _k := r.ReadFieldName(); _m[_k] = ${elemRead} }; r.EndObject(); return _m }()`;
  }
  if (type.kind === "Model" && type.name) {
    if (optional) return `func() *${type.name} { if r.IsNull() { r.ReadNull(); return nil }; return decode${type.name}(r) }()`;
    return `decode${type.name}(r)`;
  }
  return `r.ReadString()`;
}

function isSliceType(type: Type): boolean {
  const n = scalarName(type);
  if (n === "bytes") return true;
  return isArray(type);
}

function isMapType(type: Type): boolean {
  return isRecord(type);
}

function isModelType(type: Type): boolean {
  return type.kind === "Model" && !!type.name && !isArray(type) && !isRecord(type);
}

function emitModelFunctions(m: Model, pkg: string, L: string[]): void {
  if (!m.name) return;
  const fields = extractFields(m);
  const required = fields.filter(f => !f.optional);
  const optional = fields.filter(f => f.optional);

  // write${Name}(w, obj) — format-agnostic using SpecWriter
  L.push(`func write${m.name}(w specodec.SpecWriter, obj *${m.name}) {`);
  if (optional.length === 0) {
    L.push(`\tw.BeginObject(${fields.length})`);
  } else {
    L.push(`\t_n := ${required.length}`);
    for (const f of optional) {
      L.push(`\tif obj.${goExport(f.name)} != nil { _n++ }`);
    }
    L.push(`\tw.BeginObject(_n)`);
  }
  for (const f of fields) {
    const goField = goExport(f.name);
    let val: string;
    if (f.optional && (isSliceType(f.type) || isMapType(f.type) || isModelType(f.type))) {
      val = `obj.${goField}`;
    } else if (f.optional) {
      val = `*obj.${goField}`;
    } else if (isModelType(f.type)) {
      val = `&obj.${goField}`;
    } else {
      val = `obj.${goField}`;
    }
    if (f.optional) {
      L.push(`\tif obj.${goField} != nil { w.WriteField("${f.name}"); ${writeExpr(f.type, val)} }`);
    } else {
      L.push(`\tw.WriteField("${f.name}"); ${writeExpr(f.type, val)}`);
    }
  }
  L.push(`\tw.EndObject()`);
  L.push(`}`);
  L.push("");

  // decode${Name}(r)
  L.push(`func decode${m.name}(r specodec.SpecReader) *${m.name} {`);
  L.push(`\tobj := &${m.name}{}`);
  L.push(`\tr.BeginObject()`);
  L.push(`\tfor r.HasNextField() {`);
  L.push(`\t\tswitch r.ReadFieldName() {`);
  for (const f of fields) {
    const goField = goExport(f.name);
    if (f.optional && isSliceType(f.type)) {
      L.push(`\t\tcase "${f.name}": obj.${goField} = ${readExpr(f.type)}`);
    } else if (f.optional && isModelType(f.type)) {
      L.push(`\t\tcase "${f.name}": obj.${goField} = ${readExpr(f.type, true)}`);
    } else if (f.optional) {
      L.push(`\t\tcase "${f.name}": _v := ${readExpr(f.type)}; obj.${goField} = &_v`);
    } else if (isModelType(f.type)) {
      L.push(`\t\tcase "${f.name}": obj.${goField} = *${readExpr(f.type)}`);
    } else {
      L.push(`\t\tcase "${f.name}": obj.${goField} = ${readExpr(f.type)}`);
    }
  }
  L.push(`\t\tdefault: r.Skip()`);
  L.push(`\t\t}`);
  L.push(`\t}`);
  L.push(`\tr.EndObject()`);
  L.push(`\treturn obj`);
  L.push(`}`);
  L.push("");
}

function isStdLibNamespace(ns: Namespace): boolean {
  const fullName = getNamespaceFullName(ns);
  return fullName === "TypeSpec" || fullName.startsWith("TypeSpec.");
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];
  function collectFromNs(ns: Namespace, iface?: Interface) {
    if (isStdLibNamespace(ns)) return;
    const models: Model[] = [];
    const seen = new Set<string>();
    navigateTypesInNamespace(ns, {
      model: (m: Model) => {
        if (m.name && !seen.has(m.name)) {
          const modelNs = m.namespace;
          if (modelNs && !isStdLibNamespace(modelNs)) {
            models.push(m);
            seen.add(m.name);
          }
        }
      },
    });
    if (models.length > 0) {
      result.push({ 
        namespace: ns, 
        iface: iface || { name: ns.name || "TestService", namespace: ns } as Interface, 
        serviceName: iface?.name || ns.name || "TestService", 
        models 
      });
    }
  }
  for (const svc of services) collectFromNs(svc.type);
  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }
  return result;
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  const reservedFieldErrors: Diagnostic[] = [];
  for (const svc of services) {
    for (const m of svc.models) {
      if (!m.name) continue;
      for (const [fieldName, prop] of m.properties) {
        const reservedIn = checkReservedKeyword(fieldName);
        if (reservedIn.length > 0) {
          const message = formatReservedError(fieldName, m.name, reservedIn);
          const diag: Diagnostic = {
            severity: "error",
            code: "reserved-keyword",
            message,
            target: prop,
          };
          reservedFieldErrors.push(diag);
        }
      }
    }
  }

  if (reservedFieldErrors.length > 0 && !ignoreReservedKeywords) {
    program.reportDiagnostics(reservedFieldErrors);
    return;
  }

  if (reservedFieldErrors.length > 0 && ignoreReservedKeywords) {
    for (const diag of reservedFieldErrors) {
      console.warn(`Warning: ${diag.message}`);
    }
  }

  for (const svc of services) {
    const pkg = `specodec_${snake(svc.namespace.name?.toLowerCase() ?? "svc")}`;
    const L: string[] = [];
    L.push("// Generated by @specodec/typespec-specodec-go. DO NOT EDIT.");
    L.push(`package ${pkg}`);
    L.push("");
    L.push(`import specodec "github.com/specodec/specodec-go"`);
    L.push("");

    // 1. Structs
    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      L.push(`type ${m.name} struct {`);
      for (const f of fields) {
        const goField = goExport(f.name);
        const goType = typeToGo(f.type, f.optional);
        const tag = `\`json:"${f.name}${f.optional ? ",omitempty" : ""}"\``;
        L.push(`\t${goField} ${goType} ${tag}`);
      }
      L.push("}");
      L.push("");
    }

    // 2. Internal write/decode helpers
    for (const m of svc.models) {
      emitModelFunctions(m, pkg, L);
    }

    // 3. Exported SpecCodec vars
    for (const m of svc.models) {
      if (!m.name) continue;
      L.push(`var ${m.name}Codec = specodec.SpecCodec[${m.name}]{`);
      L.push(`\tEncode: func(w specodec.SpecWriter, obj *${m.name}) { write${m.name}(w, obj) },`);
      L.push(`\tDecode: func(r specodec.SpecReader) *${m.name} { return decode${m.name}(r) },`);
      L.push(`}`);
      L.push("");
    }

    const fileName = `${snake(svc.serviceName)}_types.go`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: L.join("\n") });
  }
}
