(function_signature
  name: (identifier) @name.definition.function) @definition.function

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(module
  name: (identifier) @name.definition.module) @definition.module

(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(type_annotation
  (type_identifier) @name.reference.type) @reference.type

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; -- ES module patterns ---------------------------------------------------

; Arrow functions and function expressions as const/let declarations
; e.g. export const foo = () => {}, const bar = function() {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)]) @definition.function)

; Same for var declarations
(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)]) @definition.function)

; Re-export specifiers: export { foo, bar } or export { foo } from './mod'
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @name.reference.export)) @reference.export)

; Constant value exports (captured after function patterns to avoid overwrite)
; e.g. export const PORT = 3000, const config = {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.constant
    value: (_) @_value
    (#not-match? @_value "^(async\\s+)?(function|class)\\b")
    (#not-match? @_value "^\\([^)]*\\)\\s*=>")) @definition.constant)

; Assignment expressions with function values (e.g. module.exports = function() {})
(assignment_expression
  left: [
    (identifier) @name.definition.function
    (member_expression
      property: (property_identifier) @name.definition.function)
  ]
  right: [(arrow_function) (function_expression)]
) @definition.function

; Object literal method shorthand (pair with function value)
(pair
  key: (property_identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

; Generator function declarations: function* gen() {}
(generator_function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Named generator function expressions: const x = function* gen() {}
(generator_function
  name: (identifier) @name.definition.function) @definition.function

; Var declarations with non-function values: var x = 5
(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.constant
    value: (_) @_value
    (#not-match? @_value "^(async\\s+)?(function|class)\\b")
    (#not-match? @_value "^\\([^)]*\\)\\s*=>")) @definition.constant)

; Call expression references: when a function is called
(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call
