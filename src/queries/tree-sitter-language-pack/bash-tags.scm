; Function definitions: function name() { ... } or name() { ... }
(function_definition
  name: (word) @name.definition.function) @definition.function

; Variable assignments: VAR=value
(variable_assignment
  name: (variable_name) @name.definition.variable) @definition.variable

; Command references: calling a command by name
(command
  name: (command_name
    (word) @name.reference.call)) @reference.call
