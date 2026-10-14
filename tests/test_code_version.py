import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ACQ = load("acq_code_version", "eeg_acquisition/code_version.py")
GES = load("ges_code_version", "gesture_detector/code_version.py")


def tree(files):
    d = Path(tempfile.mkdtemp())
    for rel, content in files.items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content.encode("utf-8"))
    return d


class CodeVersionTests(unittest.TestCase):
    def test_reference_vector_matches_node(self):
        d = tree({"a.py": "x\r\ny\n", "sub/b.py": "z"})
        for mod in (ACQ, GES):
            self.assertEqual(mod.hash_files(d, ["sub/b.py", "a.py"]), "df00286")

    def test_crlf_and_lf_same_hash_and_byte_change_differs(self):
        crlf = tree({"a.py": "l1\r\nl2\r\n", "b.py": "b"})
        lf = tree({"a.py": "l1\nl2\n", "b.py": "b"})
        other = tree({"a.py": "l1\nl3\n", "b.py": "b"})
        self.assertEqual(ACQ.hash_files(crlf, ["a.py", "b.py"]), ACQ.hash_files(lf, ["b.py", "a.py"]))
        self.assertNotEqual(ACQ.hash_files(lf, ["a.py", "b.py"]), ACQ.hash_files(other, ["a.py", "b.py"]))

    def test_code_version_uses_only_top_level_py(self):
        d = tree({"x.py": "1", "y.py": "2", "notes.md": "n", "__pycache__/x.cpython-311.pyc": "bin"})
        self.assertEqual(GES.code_version(d), GES.hash_files(d, ["x.py", "y.py"]))
        self.assertRegex(ACQ.code_version(), r"^[0-9a-f]{7}$")

    def test_git_info_without_git_returns_none(self):
        def boom(*args, **kwargs):
            raise FileNotFoundError("git")
        self.assertEqual(GES.git_info(ROOT, run=boom), {"branch": None, "commit": None})

    def test_git_info_reads_branch_and_commit(self):
        outs = iter(["main\n", "abc1234\n"])

        def fake(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 0, stdout=next(outs), stderr="")
        self.assertEqual(GES.git_info(ROOT, run=fake), {"branch": "main", "commit": "abc1234"})


if __name__ == "__main__":
    unittest.main()
