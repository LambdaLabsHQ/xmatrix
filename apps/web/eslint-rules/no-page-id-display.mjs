/** Page locators may route, key and query; visible text must use a title or reference renderer. */
const pageIdName = /^(?:[a-z]*page_?id|page_id)$/iu;
const visibleProps = new Set(["children", "title", "label", "text", "alt", "aria-label", "placeholder", "description"]);
const stringMethods = new Set(["slice", "substring", "substr", "toString", "toLowerCase", "toUpperCase", "trim"]);

function propertyName(node) {
  return node.computed ? node.property.value : node.property.name;
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: { raw: "Do not display a raw Page ID. Use the page title, InlineRowPreview for previews, or PageReferenceRichText for references." },
  },
  create(context) {
    const source = context.sourceCode;
    function raw(node, seen = new Set()) {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      switch (node.type) {
        case "Identifier": {
          if (pageIdName.test(node.name)) return true;
          for (let scope = source.getScope(node); scope; scope = scope.upper) {
            const variable = scope.set.get(node.name);
            if (!variable) continue;
            return variable.defs.some((def) => {
              const binding = def.name.parent;
              if (binding?.type === "Property" && binding.value === def.name
                && binding.parent.type === "ObjectPattern"
                && pageIdName.test(binding.key.name ?? binding.key.value)) return true;
              if (def.type !== "Variable") return false;
              const declaration = def.node;
              if (declaration.id.type !== "Identifier") return false;
              return raw(declaration.init, seen);
            });
          }
          return false;
        }
        case "MemberExpression": {
          const name = propertyName(node);
          return pageIdName.test(name) || (name === "id" && node.object.type === "Identifier"
            && /page$/iu.test(node.object.name));
        }
        case "TemplateLiteral": return node.expressions.some((part) => raw(part, seen));
        case "ArrayExpression": return node.elements.some((part) => raw(part, seen));
        case "SpreadElement": return raw(node.argument, seen);
        case "BinaryExpression": return node.operator === "+" && (raw(node.left, seen) || raw(node.right, seen));
        case "LogicalExpression": return (node.operator !== "&&" && raw(node.left, seen)) || raw(node.right, seen);
        case "ConditionalExpression": return raw(node.consequent, seen) || raw(node.alternate, seen);
        case "ChainExpression":
        case "TSAsExpression":
        case "TSNonNullExpression": return raw(node.expression, seen);
        case "CallExpression":
          return node.callee.type === "Identifier" && node.callee.name === "String"
            ? raw(node.arguments[0], seen)
            : node.callee.type === "MemberExpression" && stringMethods.has(propertyName(node.callee))
              && raw(node.callee.object, seen);
        default: return false;
      }
    }
    function check(node, expression) {
      if (raw(expression)) context.report({ node, messageId: "raw" });
    }
    return {
      JSXExpressionContainer(node) {
        const parent = node.parent;
        if (parent.type === "JSXAttribute" && !visibleProps.has(parent.name.name)) return;
        check(node, node.expression);
      },
      AssignmentExpression(node) {
        if (node.left.type === "MemberExpression"
          && ["textContent", "innerText"].includes(propertyName(node.left))) check(node, node.right);
      },
    };
  },
};
