import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from contextlib import closing

import desktop
from backend import runtime


class DesktopTests(unittest.TestCase):
    def test_first_run_migration_preserves_original_and_never_overwrites_existing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'old.sqlite3'
            destination = Path(directory) / 'new' / 'ledger.sqlite3'
            with closing(sqlite3.connect(source)) as db:
                db.executescript('CREATE TABLE instruments(code TEXT); CREATE TABLE trades(id INTEGER); CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO trades VALUES (404); INSERT INTO settings VALUES ("fees","keep");')
            self.assertTrue(desktop.migrate_database(source, destination))
            with closing(sqlite3.connect(destination)) as db:
                self.assertEqual(db.execute('SELECT id FROM trades').fetchone()[0], 404)
            self.assertFalse(desktop.migrate_database(source, destination))
            with closing(sqlite3.connect(source)) as db:
                self.assertEqual(db.execute('SELECT value FROM settings').fetchone()[0], 'keep')

    def test_invalid_migration_never_creates_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'other.sqlite3'; destination = Path(directory) / 'ledger.sqlite3'
            with closing(sqlite3.connect(source)) as db:
                db.execute('CREATE TABLE unrelated(id INTEGER)')
            with self.assertRaises(ValueError):
                desktop.migrate_database(source, destination)
            self.assertFalse(destination.exists())

    def test_frozen_workers_use_console_helper_not_gui_or_installed_python(self):
        with patch.object(runtime.sys, 'frozen', True, create=True), patch.object(runtime.sys, 'executable', r'C:\Portable\StockAssistant.exe'):
            command = runtime.worker_command('backend.market_worker', '513310', 'etf', '1', '0')
            self.assertEqual(Path(command[0]).name, 'StockAssistantWorker.exe')
            self.assertEqual(command[1:3], ['--worker', 'market'])
            self.assertNotIn('-m', command)
            self.assertEqual(runtime.worker_command('backend.security_search', '510300')[2], 'search')
        with self.assertRaises(ValueError):
            runtime.worker_command('unknown.module')

    def test_optional_portable_data_path_resolves_against_program_folder(self):
        with patch.object(desktop, 'application_root', return_value=Path.cwd()):
            self.assertEqual(desktop.data_directory({'data_directory': 'data'}), (Path.cwd() / 'data').resolve())
        with patch.dict(os.environ, {'LOCALAPPDATA': str(Path.cwd() / 'user')}):
            self.assertEqual(desktop.data_directory({}), Path.cwd() / 'user' / 'StockAssistant')
