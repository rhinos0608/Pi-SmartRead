(list_lit
  meta: _*
  . (sym_lit name: (sym_name) @ignore)
  . (sym_lit name: (sym_name) @name.definition.method)
  (#match? @ignore "^def.*"))

(list_lit
  . (sym_lit name: (sym_name) @name.reference.call) @reference.call
  (#not-match? @name.reference.call "^(def|defn|defmacro|defmethod|defmulti|defprotocol|let|let\*|letfn|fn|if|quote|do|when|loop|recur|try|catch|ns|in-ns|binding|with-open|case|cond|condp|for|doseq|future|proxy|gen-class|import|refer|use)$"))
