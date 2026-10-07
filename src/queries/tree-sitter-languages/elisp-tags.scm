;; defun/defsubst
(function_definition name: (symbol) @name.definition.function) @definition.function

;; Treat macros as function definitions for the sake of TAGS.
(macro_definition name: (symbol) @name.definition.function) @definition.function

;; Match function calls
(list (symbol) @name.reference.function) @reference.function
  (#not-match? @name.reference.function "^(defun|defsubst|defmacro|defvar|defconst|defcustom|let|let\\*|letrec|lambda|if|when|unless|progn|quote|function|setq|setf|apply|eval|cond|case|catch|throw|save-excursion|save-current-buffer|with-temp-buffer|with-current-buffer|pcase|pcase-let|pcase-let\\*|while|dolist|dotimes|and|or|condition-case|unwind-protect)$")
