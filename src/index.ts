import { type EmitContext, emitFile, type Model, type Type } from "@typespec/compiler";
import {
  collectServices,
  type BaseEmitterOptions,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isUnionType,
  isScalarVariant,
  arrayElementType,
  recordElementType,
  toPascalCase,
  dottedPathToSnakeCase,
  checkAndReportReservedKeywords,
  safeFieldName,
  type UnionInfo,
  type UnionVariantInfo,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

let goCurNs = "";
let goModelNs = new Map<string, string>();

function goPkg(name: string): string { return dottedPathToSnakeCase(name); }

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
  if (isArrayType(type)) return `[]${typeToGo(arrayElementType(type)!)}`;
  if (isRecordType(type)) return `map[string]${typeToGo(recordElementType(type)!)}`;
  if (type.kind === "Enum") return "string";
  if (type.kind === "Model" && (type as Model).name) return `*${(type as Model).name}`;
  if (isUnionType(type)) return (type as any).name;
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
    const elem = arrayElementType(type)!;
    return `func() { w.BeginArray(len(${varExpr})); for _, item := range ${varExpr} { w.NextElement(); ${writeExpr(elem, "item")}; }; w.EndArray() }()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    return `func() { w.BeginObject(len(${varExpr})); for key, val := range ${varExpr} { w.WriteField(key); ${writeExpr(elem, "val")}; }; w.EndObject() }()`;
  }
  if (type.kind === "Enum") return `w.WriteString(${varExpr})`;
  if (isUnionType(type)) {
    const unionName = (type as any).name;
    const ns = goModelNs.get(unionName);
    const pfx = ns && ns !== goCurNs ? goPkg(ns) + "." : "";
    return `${pfx}Write${unionName}(w, ${varExpr})`;
  }
  if (type.kind === "Model" && (type as Model).name) {
    const ns = goModelNs.get((type as Model).name!);
    const pfx = ns && ns !== goCurNs ? goPkg(ns) + "." : "";
    return `${pfx}Write${(type as Model).name}(w, ${varExpr})`;
  }
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
    const elem = arrayElementType(type)!;
    const elemGo = typeToGo(elem);
    const elemRead = readExpr(elem);
    return `func() []${elemGo} { var arr []${elemGo}; r.BeginArray(); for r.HasNextElement() { arr = append(arr, ${elemRead}) }; r.EndArray(); return arr }()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    const elemGo = typeToGo(elem);
    const elemRead = readExpr(elem);
    return `func() map[string]${elemGo} { mapResult := map[string]${elemGo}{}; r.BeginObject(); for r.HasNextField() { key := r.ReadFieldName(); mapResult[key] = ${elemRead} }; r.EndObject(); return mapResult }()`;
  }
  if (type.kind === "Enum") return "r.ReadString()";
  if (isUnionType(type)) {
    const unionName = (type as any).name;
    const ns = goModelNs.get(unionName);
    const pfx = ns && ns !== goCurNs ? goPkg(ns) + "." : "";
    if (optional)
      return `func() ${pfx}${unionName} { if r.IsNull() { r.ReadNull(); var z ${pfx}${unionName}; return z }; return ${pfx}Decode${unionName}(r) }()`;
    return `${pfx}Decode${unionName}(r)`;
  }
  if (type.kind === "Model" && (type as Model).name) {
    const modelName = (type as Model).name!;
    const ns = goModelNs.get(modelName);
    const pfx = ns && ns !== goCurNs ? goPkg(ns) + "." : "";
    if (optional)
      return `func() *${pfx}${modelName} { if r.IsNull() { r.ReadNull(); return nil }; return ${pfx}Decode${modelName}(r) }()`;
    return `${pfx}Decode${modelName}(r)`;
  }
  return `r.ReadString()`;
}

function emitModelFunctions(m: Model, L: string[]): void {
  if (!m.name) return;
  const fields = extractFields(m);
  const required = fields.filter((f) => !f.optional);
  const optional = fields.filter((f) => f.optional);

  L.push(`func Write${m.name}(w specodec.SpecWriter, obj *${m.name}) {`);
  if (optional.length === 0) {
    L.push(`	w.BeginObject(${fields.length})`);
  } else {
    L.push(`	fieldCount := ${required.length}`);
    for (const f of optional) {
      const fGo = toPascalCase(f.name); L.push(`	if obj.${fGo} != nil { fieldCount++ }`);
    }
    L.push(`	w.BeginObject(fieldCount)`);
  }
  for (const f of fields) {
      const fGo = safeFieldName("go", toPascalCase(f.name));
      if (f.optional) {
        const goType = typeToGo(f.type);
        const deref = goType.startsWith("*") ? `obj.${fGo}` : `*obj.${fGo}`;
        L.push(`	if obj.${fGo} != nil { w.WriteField("${f.name}"); ${writeExpr(f.type, deref)}; }`);
    } else {
      L.push(`	w.WriteField("${f.name}"); ${writeExpr(f.type, `obj.${fGo}`)};`);
    }
  }
  L.push(`	w.EndObject()`);
  L.push(`}`);
  L.push("");

  L.push(`func Decode${m.name}(r specodec.SpecReader) *${m.name} {`);
  L.push(`	obj := &${m.name}{}`);
  L.push(`	r.BeginObject()`);
  L.push(`	for r.HasNextField() {`);
  L.push(`		switch r.ReadFieldName() {`);
  for (const f of fields) {
    const fGo = toPascalCase(f.name);
    const fieldRead = readExpr(f.type, f.optional);
    if (f.optional) {
      const goType = typeToGo(f.type);
      if (goType.startsWith("*")) {
        L.push(`		case "${f.name}": obj.${fGo} = ${fieldRead}`);
      } else {
        L.push(`		case "${f.name}": val := ${fieldRead}; obj.${fGo} = &val`);
      }
    } else {
      L.push(`		case "${f.name}": obj.${fGo} = ${fieldRead}`);
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

function generateUnionCode(u: UnionInfo, L: string[]): void {
  const unionName = u.name;

  L.push(`type ${unionName} interface { is${unionName}() }`);
  L.push("");

  L.push(`type ${unionName}Undefined struct{}`);
  L.push(`func (${unionName}Undefined) is${unionName}() {}`);
  L.push("");

  for (const v of u.variants) {
    const pascalVariant = toPascalCase(v.name);
    const goType = typeToGo(v.type);
    L.push(`type ${unionName}${pascalVariant} struct { Value ${goType} }`);
    L.push(`func (${unionName}${pascalVariant}) is${unionName}() {}`);
    L.push("");
  }

  L.push(`func Write${unionName}(w specodec.SpecWriter, obj ${unionName}) {`);
  L.push(`	w.BeginObject(1)`);
  L.push(`	switch v := obj.(type) {`);
  for (const v of u.variants) {
    const pascalVariant = toPascalCase(v.name);
    L.push(`	case ${unionName}${pascalVariant}: w.WriteField("${v.name}"); ${writeExpr(v.type, "v.Value")}`);
  }
  L.push(`	case ${unionName}Undefined: panic("cannot encode Undefined for ${unionName}")`);
  L.push(`	}`);
  L.push(`	w.EndObject()`);
  L.push(`}`);
  L.push("");

  L.push(`func Decode${unionName}(r specodec.SpecReader) ${unionName} {`);
  L.push(`	var result ${unionName} = ${unionName}Undefined{}`);
  L.push(`	r.BeginObject()`);
  L.push(`	if !r.HasNextField() { r.EndObject(); panic("empty union ${unionName}") }`);
  L.push(`	field := r.ReadFieldName()`);
  L.push(`	switch field {`);
  for (const v of u.variants) {
    const pascalVariant = toPascalCase(v.name);
    L.push(`	case "${v.name}": result = ${unionName}${pascalVariant}{Value: ${readExpr(v.type)}}`);
  }
  L.push(`	default: panic("unknown variant " + field)`);
  L.push(`	}`);
  L.push(`	for r.HasNextField() { r.ReadFieldName(); r.Skip() }`);
  L.push(`	r.EndObject()`);
  L.push(`	return result`);
  L.push(`}`);
  L.push("");

  L.push(`var ${unionName}Codec = specodec.SpecCodec[${unionName}]{`);
  L.push(`	Encode: func(w specodec.SpecWriter, obj *${unionName}) { Write${unionName}(w, *obj) },`);
  L.push(`	Decode: func(r specodec.SpecReader) *${unionName} { v := Decode${unionName}(r); return &v },`);
  L.push(`}`);
  L.push("");
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  // Build model→namespace map for cross-package references
  const modelNs = new Map<string, string>();
  for (const s of services) {
    for (const m of s.models) { if (m.name) modelNs.set(m.name, s.serviceName); }
    for (const e of s.enums) { if (e.name) modelNs.set(e.name, s.serviceName); }
    for (const u of s.unions) { if (u.name) modelNs.set(u.name, s.serviceName); }
  }
  goModelNs = modelNs;

  for (const svc of services) {
    goCurNs = svc.serviceName;
    const L: string[] = [];
    const pkg = dottedPathToSnakeCase(svc.serviceName);

    // Detect cross-namespace types used by models in this namespace
    const xrefTypes = new Set<string>();
    const xrefPkgs = new Set<string>();
    const collectX = (t: Type) => {
      if ((t.kind === "Model" || t.kind === "Enum" || isUnionType(t)) && (t as any).name) {
        const ns = modelNs.get((t as any).name);
        if (ns && ns !== svc.serviceName) {
          xrefTypes.add((t as any).name);
          xrefPkgs.add(dottedPathToSnakeCase(ns));
        }
      }
      if (isArrayType(t)) collectX(arrayElementType(t)!!);
      if (isRecordType(t)) collectX(recordElementType(t)!!);
    };
    for (const m of svc.models) {
      if (!m.name) continue;
      for (const f of extractFields(m)) {
        collectX(f.type);
      }
    }
    for (const u of svc.unions) {
      for (const v of u.variants) {
        collectX(v.type);
      }
    }

    L.push(`// Generated by @specodec/typespec-emitter-golang. DO NOT EDIT.`);
    L.push(`package ${pkg}`);
    L.push("");

    // Import block
    const sortedPkgs = [...xrefPkgs].sort();
    if (sortedPkgs.length > 0) {
      L.push(`import (`);
      L.push(`\tspecodec "github.com/specodec/specodec-runtime-golang"`);
      for (const xp of sortedPkgs) L.push(`\t${xp} "emit_go/emit_gen/${xp}"`);
      L.push(`)`);
    } else {
      L.push(`import specodec "github.com/specodec/specodec-runtime-golang"`);
    }
    L.push("");

    // Facade type aliases for cross-namespace types
    if (xrefTypes.size > 0) {
      for (const t of [...xrefTypes].sort()) {
        const ns = modelNs.get(t)!;
        L.push(`type ${t} = ${dottedPathToSnakeCase(ns)}.${t}`);
      }
      L.push("");
    }

    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      L.push(`type ${m.name} struct {`);
      for (const f of fields) {
        const fGo = safeFieldName("go", toPascalCase(f.name));
        const goType = typeToGo(f.type);
        const needsPtr = f.optional && !goType.startsWith("*");
        L.push(`	${fGo} ${needsPtr ? "*" : ""}${goType}`);
      }
      L.push(`}`);
      L.push("");
    }

    for (const m of svc.models) emitModelFunctions(m, L);

    for (const u of svc.unions) { generateUnionCode(u, L); }

    for (const m of svc.models) {
      if (!m.name) continue;
      L.push(`var ${m.name}Codec = specodec.NewCodec(Write${m.name}, Decode${m.name})`);
      L.push("");
    }

    const fileName = `${dottedPathToSnakeCase(svc.serviceName)}_types.go`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: L.join("\n") });
  }
}
