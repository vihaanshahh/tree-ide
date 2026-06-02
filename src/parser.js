const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScriptModule = require('tree-sitter-typescript');
const Python = require('tree-sitter-python');
const Go = require('tree-sitter-go');
const Rust = require('tree-sitter-rust');

const parsers = {
  '.js': JavaScript,
  '.jsx': JavaScript,
  '.mjs': JavaScript,
  '.cjs': JavaScript,
  '.ts': TypeScriptModule.typescript,
  '.mts': TypeScriptModule.typescript,
  '.cts': TypeScriptModule.typescript,
  '.tsx': TypeScriptModule.tsx,
  '.py': Python,
  '.go': Go,
  '.rs': Rust,
};

function getParser(ext) {
  const lang = parsers[ext];
  if (!lang) return null;
  const p = new Parser();
  p.setLanguage(lang);
  return { parser: p, language: lang };
}

/**
 * Extracts exports and imports from a source file using Tree-Sitter.
 * This intentionally returns partial metadata; scanner.js merges it with the
 * legacy extractors so parser gaps never erase existing graph edges.
 */
function analyzeAST(ext, content) {
  const entry = getParser(ext);
  if (!entry) return null;

  const tree = entry.parser.parse(content);
  const root = tree.rootNode;

  const results = {
    exports: [],
    imports: [],
  };

  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
    extractJSLike(root, results);
  } else if (ext === '.py') {
    extractPython(root, results);
  } else if (ext === '.go') {
    extractGo(root, results);
  } else if (ext === '.rs') {
    extractRust(root, results);
  }

  return results;
}

function unquote(s) {
  return String(s || '').replace(/^['"`]|['"`]$/g, '');
}

function isLocalSource(source) {
  return source.startsWith('.') || source.startsWith('/') || source.startsWith('@') || source.startsWith('~');
}

function walk(node, fn) {
  fn(node);
  for (const child of node.namedChildren || []) walk(child, fn);
}

function addExport(results, name, kind, node) {
  if (!name || String(name).startsWith('_')) return;
  results.exports.push({
    name,
    kind,
    line: node.startPosition.row + 1,
  });
}

function addImport(results, source, names = [], local = isLocalSource(source)) {
  if (!source) return;
  results.imports.push({
    source,
    names: [...new Set(names.filter(Boolean))],
    local,
  });
}

function firstDescendant(node, types) {
  let hit = null;
  walk(node, (child) => {
    if (!hit && types.has(child.type)) hit = child;
  });
  return hit;
}

function collectImportNames(importNode) {
  const names = [];
  const clause = importNode.childForFieldName('import_clause') ||
    (importNode.namedChildren || []).find(n => n.type === 'import_clause');
  if (!clause) return names;

  for (const child of clause.namedChildren || []) {
    if (child.type === 'identifier') {
      names.push(child.text);
    } else if (child.type === 'import_specifier') {
      const alias = child.childForFieldName('alias');
      const name = child.childForFieldName('name');
      names.push((alias || name)?.text);
    } else if (child.type === 'namespace_import') {
      const alias = child.childForFieldName('alias') || firstDescendant(child, new Set(['identifier']));
      names.push(alias?.text);
    } else if (child.type === 'named_imports') {
      for (const spec of child.namedChildren || []) {
        if (spec.type !== 'import_specifier') continue;
        const alias = spec.childForFieldName('alias');
        const name = spec.childForFieldName('name');
        names.push((alias || name)?.text);
      }
    }
  }

  return names.filter(Boolean);
}

function declarationExportKind(node) {
  if (!node) return 'named';
  if (node.type.includes('function') || node.type === 'method_definition') return 'function';
  if (node.type.includes('class')) return 'class';
  if (node.type.includes('interface') || node.type.includes('type_alias') || node.type.includes('enum')) return 'type';
  return 'const';
}

function addJSDeclarationExports(results, declaration) {
  if (!declaration) return false;
  let added = false;
  if (['function_declaration', 'generator_function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration'].includes(declaration.type)) {
    const name = declaration.childForFieldName('name');
    if (name) {
      addExport(results, name.text, declarationExportKind(declaration), name);
      added = true;
    }
  } else if (['lexical_declaration', 'variable_declaration'].includes(declaration.type)) {
    for (const child of declaration.namedChildren || []) {
      if (child.type !== 'variable_declarator') continue;
      const name = child.childForFieldName('name');
      if (!name) continue;
      const value = child.childForFieldName('value');
      const kind = value && (value.type.includes('function') || value.type === 'arrow_function') ? 'function' : 'const';
      addExport(results, name.text, kind, name);
      added = true;
    }
  }
  return added;
}

function extractJSLike(root, results) {
  walk(root, (node) => {
    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source');
      if (source) addImport(results, unquote(source.text), collectImportNames(node));
      return;
    }

    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (!fn || !['require', 'import'].includes(fn.text)) return;
      const args = node.childForFieldName('arguments');
      const source = firstDescendant(args || node, new Set(['string']));
      if (source) addImport(results, unquote(source.text));
      return;
    }

    if (node.type !== 'export_statement') return;
    const declaration = node.childForFieldName('declaration') ||
      (node.namedChildren || []).find(child => child.type !== 'export_clause');
    const addedDeclaration = addJSDeclarationExports(results, declaration);

    const clause = (node.namedChildren || []).find(child => child.type === 'export_clause');
    if (clause) {
      for (const spec of clause.namedChildren || []) {
        if (spec.type !== 'export_specifier') continue;
        const alias = spec.childForFieldName('alias');
        const name = spec.childForFieldName('name');
        addExport(results, (alias || name)?.text, 'named', alias || name || spec);
      }
    } else if (!addedDeclaration && /\bdefault\b/.test(node.text)) {
      addExport(results, 'default', 'default', node);
    }
  });
}

function extractPython(root, results) {
  walk(root, (node) => {
    if (node.type === 'function_definition') {
      const name = node.childForFieldName('name');
      if (name) addExport(results, name.text, 'function', name);
    } else if (node.type === 'class_definition') {
      const name = node.childForFieldName('name');
      if (name) addExport(results, name.text, 'class', name);
    } else if (node.type === 'import_from_statement') {
      const source = node.childForFieldName('module_name');
      if (source) addImport(results, source.text, [], true);
    } else if (node.type === 'import_statement') {
      for (const child of node.namedChildren || []) {
        if (child.type === 'dotted_name') addImport(results, child.text, [], false);
        else if (child.type === 'aliased_import') {
          const name = child.childForFieldName('name');
          if (name) addImport(results, name.text, [], false);
        }
      }
    }
  });
}

function extractGo(root, results) {
  walk(root, (node) => {
    if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name');
      if (name) addExport(results, name.text, 'function', name);
    } else if (node.type === 'type_spec') {
      const name = node.childForFieldName('name');
      if (name) addExport(results, name.text, 'class', name);
    } else if (node.type === 'import_spec') {
      const path = node.childForFieldName('path');
      if (path) addImport(results, unquote(path.text), [], false);
    }
  });
}

function extractRust(root, results) {
  walk(root, (node) => {
    if (node.type === 'function_item') {
      const name = node.childForFieldName('name');
      if (name) addExport(results, name.text, 'function', name);
    } else if (['struct_item', 'enum_item', 'trait_item'].includes(node.type)) {
      const name = node.childForFieldName('name');
      if (name) addExport(results, name.text, 'class', name);
    } else if (node.type === 'use_declaration') {
      const argument = node.childForFieldName('argument') || node.namedChildren?.[0];
      if (argument) addImport(results, argument.text, [], /^(crate|self|super)\b/.test(argument.text));
    } else if (node.type === 'mod_item') {
      const name = node.childForFieldName('name');
      if (name) addImport(results, name.text, [], true);
    }
  });
}

function dedupeAnalysis(out) {
  const exportSeen = new Set();
  out.exports = out.exports.filter(e => {
    const key = `${e.name}:${e.kind}:${e.line}`;
    if (exportSeen.has(key)) return false;
    exportSeen.add(key);
    return true;
  });

  const importsBySource = new Map();
  for (const imp of out.imports) {
    const existing = importsBySource.get(imp.source);
    if (!existing) {
      importsBySource.set(imp.source, { ...imp, names: [...(imp.names || [])] });
    } else {
      existing.local = existing.local || imp.local;
      existing.names = [...new Set([...(existing.names || []), ...(imp.names || [])])];
    }
  }
  out.imports = [...importsBySource.values()];
  return out;
}

module.exports = {
  analyzeAST: (ext, content) => {
    const out = analyzeAST(ext, content);
    return out ? dedupeAnalysis(out) : null;
  },
};
