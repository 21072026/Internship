// Read only the expressions used by callModel, never execute a feature module
// (some import database/gate code). TypeScript's parser excludes comments, so a
// removed rule cannot survive the gate by appearing in a comment instead.
import ts from 'typescript';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const root = process.cwd();
function source(file) {
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(path.join(root, 'src') + path.sep)) throw new Error('Contract source must be under src/');
  return ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
}
function expression(node, file, bindings, stack = []) {
  const declarations = new Map();
  const imports = new Map();
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) declarations.set(d.name.text, d.initializer);
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (ts.isImportDeclaration(statement)) for (const spec of statement.importClause?.namedBindings?.elements ?? []) {
      imports.set(spec.name.text, { module: statement.moduleSpecifier.text, name: spec.propertyName?.text ?? spec.name.text });
    }
  }
  const globals = { ...bindings };
  for (const name of new Set([...declarations.keys(), ...imports.keys()])) {
    if (Object.hasOwn(globals, name)) throw new Error(`Fixture cannot override source constant ${name}`);
    Object.defineProperty(globals, name, { get() {
      const key = `${file.fileName}:${name}`;
      if (stack.includes(key)) throw new Error(`Circular prompt constant: ${name}`);
      if (declarations.has(name)) return expression(declarations.get(name), file, bindings, [...stack, key]);
      const spec = imports.get(name);
      const target = spec.module.startsWith('@/') ? path.join('src', spec.module.slice(2))
        : spec.module.startsWith('.') ? path.resolve(path.dirname(file.fileName), spec.module) : null;
      if (!target) throw new Error(`Prompt expression cannot load package ${spec.module}`);
      const imported = source(target + '.ts');
      const declaration = findDeclaration(imported, spec.name);
      return expression(declaration, imported, {}, [...stack, key]);
    } });
  }
  // Expressions come from reviewed repository source, never fixture code. No
  // require/process/fetch is supplied; a contract needing I/O must fail closed.
  const code = ts.isFunctionDeclaration(node) ? `(${node.getText(file).replace(/^export\s+/, '')})` : `(${node.getText(file)})`;
  const js = ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
  return vm.runInNewContext(js, globals, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
}
function findDeclaration(file, name) {
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) if (d.name.getText(file) === name && d.initializer) return d.initializer;
  }
  throw new Error(`Missing prompt constant ${name} in ${file.fileName}`);
}
export function readConstant(file, name) {
  const parsed = source(file);
  return expression(findDeclaration(parsed, name), parsed, {});
}
export function readPrompt(module, callIndex, bindings = {}) {
  const parsed = source(module);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'callModel') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  const call = calls[callIndex];
  if (!call || !ts.isObjectLiteralExpression(call.arguments[0])) throw new Error(`Missing callModel #${callIndex} in ${module}`);
  const fields = new Map(call.arguments[0].properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(parsed), p.initializer]));
  for (const p of call.arguments[0].properties) if (ts.isShorthandPropertyAssignment(p)) fields.set(p.name.text, p.name);
  const value = key => fields.has(key) ? expression(fields.get(key), parsed, bindings) : undefined;
  return JSON.parse(JSON.stringify({ task: value('task'), system: value('system'), jsonSchema: value('jsonSchema'), maxTokens: value('maxTokens') }));
}
