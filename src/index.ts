import {
  EmitContext,
  emitFile,
  Model,
  Type,
} from "@typespec/compiler";
import {
  collectServices,
  ServiceInfo,
  BaseEmitterOptions,
  FieldInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  arrayElementType,
  recordElementType,
  toSnakeCase,
  checkAndReportReservedKeywords,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function typeToGo(type: Type): string {
  const n = scalarName(type);
  if (n === "string") return "string";
  if (n === "boolean") return "bool";
  if (n === "int8") return "int8";
  if (n === "int16") return "int16";
  if (n === "int32" || n === "integer") return "int32";
  if (n === "int64") return "int64";
  if (n === "uint8") return "uint8";
  if (n === "uint16") return "uint16";
  if (n === "uint32") return "uint32";
  if (n === "uint64") return "uint64";
  if (n === "float32") return "float32";
  if (n === "float64" || n === "float" || n === "decimal") return "float64";
  if (n === "bytes") return "[]byte";
  if (isArrayType(type)) return `[]${typeToGo(arrayElementType(type))}`;
  if (isRecordType(type)) return `map[string]${typeToGo(recordElementType(type))}`;
  if (type.kind === "Model" && (type as Model).name) return `*${(type as Model).name}`;
  return "interface{}";
}

function writeExpr(type: Type, varExpr: string): string {
  const n = scalarName(type);
  if (n === "string") return `w.WriteString(${varExpr})`;
  if (n === "boolean") return `w.WriteBool(${varExpr})`;
  if (n === "int8") return `w.WriteInt32(int32(${varExpr}))`;
  if (n === "int16") return `w.WriteInt32(int32(${varExpr}))`;
  if (n === "int32" || n === "integer") return `w.WriteInt32(${varExpr})`;
  if (n === "int64") return `w.WriteInt64(${varExpr})`;
  if (n === "uint8") return `w.WriteUint32(uint32(${varExpr}))`;
  if (n === "uint16") return `w.WriteUint32(uint32(${varExpr}))`;
  if (n === "uint32") return `w.WriteUint32(${varExpr})`;
  if (n === "uint64") return `w.WriteUint64(${varExpr})`;
  if (n === "float32") return `w.WriteFloat32(${varExpr})`;
  if (n === "float64" || n === "float" || n === "decimal") return `w.WriteFloat64(${varExpr})`;
  if (n === "bytes") return `w.WriteBytes(${varExpr})`;
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return `func() { w.BeginArray(len(${varExpr})); for _, _e := range ${varExpr} { w.NextElement(); ${writeExpr(elem, "_e")}; }; w.EndArray() }()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    return `func() { w.BeginObject(len(${varExpr})); for _k, _v := range ${varExpr} { w.WriteField(_k); ${writeExpr(elem, "_v")}; }; w.EndObject() }()`;
  }
  if (type.kind === "Model" && (type as Model).name) return `write${(type as Model).name}(w, ${varExpr})`;
  return `w.WriteString(fmt.Sprintf("%v", ${varExpr}))`;
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
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    const elemGo = typeToGo(elem);
    const elemRead = readExpr(elem);
    return `func() []${elemGo} { var _a []${elemGo}; r.BeginArray(); for r.HasNextElement() { _a = append(_a, ${elemRead}) }; r.EndArray(); return _a }()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    const elemGo = typeToGo(elem);
    const elemRead = readExpr(elem);
    return `func() map[string]${elemGo} { _m := map[string]${elemGo}{}; r.BeginObject(); for r.HasNextField() { _k := r.ReadFieldName(); _m[_k] = ${elemRead} }; r.EndObject(); return _m }()`;
  }
  if (type.kind === "Model" && (type as Model).name) {
    if (optional) return `func() *${(type as Model).name} { if r.IsNull() { r.ReadNull(); return nil }; return decode${(type as Model).name}(r) }()`;
    return `decode${(type as Model).name}(r)`;
  }
  return `r.ReadString()`;
}

function emitModelFunctions(m: Model, L: string[]): void {
  if (!m.name) return;
  const fields = extractFields(m);
  const required = fields.filter(f => !f.optional);
  const optional = fields.filter(f => f.optional);

  L.push(`func write${m.name}(w specodec.SpecWriter, obj *${m.name}) {`);
  if (optional.length === 0) {
    L.push(`	w.BeginObject(${fields.length})`);
  } else {
    L.push(`	_n := ${required.length}`);
    for (const f of optional) L.push(`	if obj.${f.name} != nil { _n++ }`);
    L.push(`	w.BeginObject(_n)`);
  }
  for (const f of fields) {
      if (f.optional) {
        const goType = typeToGo(f.type);
        const deref = goType.startsWith("*") ? `obj.${f.name}` : `*obj.${f.name}`;
        L.push(`	if obj.${f.name} != nil { w.WriteField("${f.name}"); ${writeExpr(f.type, deref)}; }`);
    } else {
      L.push(`	w.WriteField("${f.name}"); ${writeExpr(f.type, `obj.${f.name}`)};`);
    }
  }
  L.push(`	w.EndObject()`);
  L.push(`}`);
  L.push("");

  L.push(`func decode${m.name}(r specodec.SpecReader) *${m.name} {`);
  L.push(`	obj := &${m.name}{}`);
  L.push(`	r.BeginObject()`);
  L.push(`	for r.HasNextField() {`);
  L.push(`		switch r.ReadFieldName() {`);
  for (const f of fields) {
    const fieldRead = readExpr(f.type, f.optional);
    if (f.optional) {
      const goType = typeToGo(f.type);
      if (goType.startsWith("*")) {
        L.push(`		case "${f.name}": obj.${f.name} = ${fieldRead}`);
      } else {
        L.push(`		case "${f.name}": _v := ${fieldRead}; obj.${f.name} = &_v`);
      }
    } else {
      L.push(`		case "${f.name}": obj.${f.name} = ${fieldRead}`);
    }
  }
  L.push(`		default: r.Skip()`);
  L.push(`		}`);
  L.push(`	}`);
  L.push(`	r.EndObject()`);
  L.push(`	return obj`);
  L.push(`}`);
  L.push("");
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  for (const svc of services) {
    const L: string[] = [];
    const nsName = svc.namespace.name;
    const pkg = `specodec_${toSnakeCase(nsName && nsName !== "global" ? nsName : "globalnamespace")}`;

    L.push(`// Generated by @specodec/typespec-emitter-golang. DO NOT EDIT.`);
    L.push(`package ${pkg}`);
    L.push("");
    L.push(`import specodec "github.com/specodec/specodec-runtime-golang"`);
    L.push("");

    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      L.push(`type ${m.name} struct {`);
      for (const f of fields) {
        const goType = typeToGo(f.type);
        const needsPtr = f.optional && !goType.startsWith("*");
        L.push(`	${f.name} ${needsPtr ? "*" : ""}${goType}`);
      }
      L.push(`}`);
      L.push("");
    }

    for (const m of svc.models) emitModelFunctions(m, L);

    for (const m of svc.models) {
      if (!m.name) continue;
      L.push(`var ${m.name}Codec = specodec.NewCodec(write${m.name}, decode${m.name})`);
      L.push("");
    }

    const fileName = `${toSnakeCase(svc.serviceName)}_types.go`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: L.join("\n") });
  }
}
