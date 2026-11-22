import ast,hashlib,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import plain_word_workload as w

class OriginalWords(unittest.TestCase):
    def test_original100_all_forms_and_102_pieces_exact_input_pin(self):
        c=w.original_source100();self.assertEqual(len(c['words']),100);self.assertEqual(len(w._plain_tokens(c['text'])),102)
        self.assertEqual(hashlib.sha256(c['text'].encode()).hexdigest(),w.ORIGINAL_INPUT_UTF8_SHA256)
    def test_both_exclusive_languages_and_shared_ambiguity_remain(self):
        groups=w._plain_source_groups();self.assertEqual([len(groups[k]) for k in ('uk','ru','shared')],[29,29,38])
        c=w.original_source100();self.assertTrue(all(row['authored_locale'] is None for row in c['words']))
    def test_exact_route_auditor_passes_original_expectations(self):
        c=w.original_source100();routes=[{'text':r['word']+' ','language':r['expected_language']} for r in c['words']]
        a=w.audit_original100(routes);self.assertTrue(a['routing_passed']);self.assertTrue(a['lexical_content_preserved_in_order'])
    def test_unexplained_title_is_not_filtered_out(self):
        c=w.original_source100();routes=[{'text':'Default terminal','language':'en'}]+[{'text':r['word']+' ','language':r['expected_language']} for r in c['words']]
        a=w.audit_original100(routes);self.assertFalse(a['routing_passed']);self.assertFalse(a['lexical_content_preserved_in_order'])
    def test_missing_whole_source_word_rejected(self):
        c=w.original_source100();routes=[{'text':r['word']+' ','language':r['expected_language']} for r in c['words'][1:]]
        self.assertFalse(w.audit_original100(routes)['routing_passed'])
    def test_each_call_returns_fresh_expectations(self):
        c=w.original_source100();c['words'][0]['expected_language']='xx';c['words'][0]['memberships'].append('xx')
        fresh=w.original_source100();self.assertEqual(fresh['words'][0]['expected_language'],'uk');self.assertEqual(fresh['words'][0]['memberships'],['uk'])
    def test_original_selected_helper_nodes_keep_exact_pinned_digest(self):
        source=Path(w.__file__).read_text();pieces=[]
        wanted={'_plain_normalize','_plain_tokens','_plain_source_groups','_plain_cases','_plain_route_audit','_plain_sequence'}
        for node in ast.parse(source).body:
            if isinstance(node,ast.Import) and all(a.name in {'unicodedata','re'} for a in node.names):pieces.append(ast.get_source_segment(source,node))
            elif isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='PLAIN_SOURCE_CASES' for t in node.targets):pieces.append(ast.get_source_segment(source,node))
            elif isinstance(node,ast.FunctionDef) and node.name in wanted:pieces.append(ast.get_source_segment(source,node))
        self.assertEqual(hashlib.sha256('\n\n'.join(pieces).encode()).hexdigest(),w.ORIGINAL_PURE_HELPERS_SHA256)
    def test_no_runtime_imports_or_observer_logic_in_fixture(self):
        tree=ast.parse(Path(w.__file__).read_text());imports=[]
        for node in ast.walk(tree):
            if isinstance(node,ast.Import):imports.extend(a.name for a in node.names)
        self.assertEqual(set(imports),{'unicodedata','re','hashlib'})
        self.assertNotIn('synthDriverHandler',Path(w.__file__).read_text())

if __name__=='__main__':unittest.main()
