"""Run with the Python dependencies from the Knowledge image."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

PARSER = Path(__file__).resolve().parents[1] / 'src/runtime/document-parser.py'


class ParserProtocolTest(unittest.TestCase):
    def test_sector_warning_does_not_interrupt_the_next_document(self):
        # Compound File Binary header plus an incomplete final sector. xlrd
        # warns before rejecting the missing workbook stream.
        header = bytearray(514)
        header[:8] = bytes.fromhex('d0cf11e0a1b11ae1')
        struct.pack_into('<HHHHH', header, 24, 62, 3, 0xfffe, 9, 6)
        header[76:512] = b'\xff' * 436
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'set.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('warning.xls', header)
                bundle.writestr('notes.txt', 'A readable sibling')
            result = subprocess.run([sys.executable, str(PARSER), str(archive), '--name', 'set.zip'],
                                    capture_output=True, text=True, check=True)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertIn('not 512 + multiple of sector size', result.stderr)
        documents = {e['path']: e['status'] for e in events if e['type'] == 'document'}
        self.assertEqual(documents, {'warning.xls': 'failed', 'notes.txt': 'parsed'})
        self.assertEqual(events[-1], {'type': 'done', 'documents': 2, 'passages': 1})


if __name__ == '__main__':
    unittest.main()
