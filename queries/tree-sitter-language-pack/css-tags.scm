; Class selector definitions: .className { ... }
(rule_set
  selectors: (class_selector
    (class_name) @name.definition.class)) @definition.class

; ID selector definitions: #idName { ... }
(rule_set
  selectors: (id_selector
    (id_name) @name.definition.id)) @definition.id

; Tag name selector definitions: tagName { ... }
(rule_set
  selectors: (tag_name) @name.definition.type) @definition.type

; @keyframes animation definitions
(keyframes_statement
  name: (identifier) @name.definition.function) @definition.function

; Font face declarations
(font_face_statement) @definition.type
