"""Owned process/file-handle maintenance proof; no audio-device emulation."""
from contextlib import ExitStack
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Event, Thread
import unittest
from unittest.mock import Mock, patch

from nvda_stubs import driver_module


class Owner:
    pass


class PackageQuiescenceTests(unittest.TestCase):
    def setUp(self):
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.driver = self.context.enter_context(driver_module())
        self.root = Path(self.context.enter_context(tempfile.TemporaryDirectory()))
        self.processes = []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        session = self.driver._package_maintenance
        if session is not None:
            session['quiesced'] = True
            self.driver.end_package_maintenance(session)
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
            for pipe in (process.stdin, process.stdout):
                if pipe is not None and not pipe.closed:
                    pipe.close()
        self.driver.close_shared_worker()

    def worker(self):
        return self.driver.SpeechWorker(sys.executable, self.root / 'unused.py', self.root)

    def owner(self, engine=None, english=None):
        owner = Owner()
        owner._closed = False
        owner._engine, owner._english_engine = engine, english
        owner._worker_lease = None
        owner._thread = None
        self.driver._live_drivers.add(owner)
        return owner

    def mapped_child(self, path):
        code = ('import mmap,sys,time; '
                'f=open(sys.argv[1],"rb"); '
                'm=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ); '
                'sys.stdout.buffer.write(b"mapped\\n"); sys.stdout.buffer.flush(); time.sleep(120)')
        process = subprocess.Popen([sys.executable, '-I', '-c', code, str(path)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        self.assertEqual(process.stdout.readline(), b'mapped\n')
        return process

    def test_real_owned_mapped_child_exits_before_maintenance_can_mutate(self):
        model = self.root / 'model.bin'
        model.write_bytes(b'x' * 4096)
        worker = self.worker()
        worker._process = process = self.mapped_child(model)
        owner = self.owner(worker)
        session = self.driver.begin_package_maintenance(owner)
        owner._closed = True
        self.driver.quiesce_package_maintenance(session, timeout=3)
        self.assertIsNotNone(process.poll())
        self.assertTrue(process.stdin.closed)
        self.assertTrue(process.stdout.closed)
        self.assertIsNone(worker._process)
        with patch.object(self.driver.subprocess, 'Popen', side_effect=AssertionError('retired worker respawned')):
            with self.assertRaises(RuntimeError):
                worker._send({'mode': 'speak'})
        self.assertTrue(self.driver.end_package_maintenance(session))

    @unittest.skipUnless(os.name == 'nt', 'Windows mmap replacement semantics require actual Windows')
    def test_windows_readonly_mmap_blocks_replace_until_real_retirement(self):
        model, replacement = self.root / 'model.bin', self.root / 'replacement.bin'
        model.write_bytes(b'x' * 4096)
        replacement.write_bytes(b'new model')
        worker, lease = self.driver.acquire_shared_worker(sys.executable, self.root / 'unused.py', self.root, None, 'mixed')
        worker._process = process = self.mapped_child(model)
        owner = self.owner(worker)
        owner._worker_lease = lease
        # Reproduce the bug: releasing an idle shared lease retains its process.
        self.driver.release_shared_worker(lease)
        with self.assertRaises(PermissionError):
            os.replace(replacement, model)
        self.assertIsNone(process.poll())
        session = self.driver.begin_package_maintenance(owner)
        owner._closed = True
        for attempt in (lambda: self.driver.acquire_shared_worker(sys.executable, 'x', self.root, None, 'mixed'),
                        self.worker, self.driver.SynthDriver):
            with self.assertRaises(RuntimeError):
                attempt()
        self.driver.quiesce_package_maintenance(session, timeout=5)
        self.assertIsNotNone(process.poll())
        os.replace(replacement, model)
        self.assertEqual(model.read_bytes(), b'new model')
        self.assertTrue(self.driver.end_package_maintenance(session))
        fresh, token = self.driver.acquire_shared_worker(sys.executable, 'x', self.root, None, 'mixed')
        self.assertIsNot(fresh, worker)
        self.assertFalse(fresh._retired)
        self.driver.release_shared_worker(token)

    def test_barrier_blocks_new_driver_shared_and_private_workers(self):
        owner = self.owner(self.worker())
        session = self.driver.begin_package_maintenance(owner)
        for attempt in (lambda: self.driver.acquire_shared_worker(sys.executable, 'x', self.root, None, 'mixed'),
                        self.worker, self.driver.SynthDriver):
            with self.assertRaises(RuntimeError):
                attempt()
        # Abort before switching: the owner's workers have not been retired.
        self.assertTrue(self.driver.end_package_maintenance(session))
        self.assertFalse(owner._engine._retired)

    def test_other_active_owner_or_foreign_lease_aborts_without_closing_any_worker(self):
        first, second = self.owner(Mock()), self.owner(Mock())
        with self.assertRaisesRegex(RuntimeError, 'Інший екземпляр'):
            self.driver.begin_package_maintenance(first)
        first._engine.retire.assert_not_called()
        second._engine.retire.assert_not_called()
        second._closed = True
        foreign = dict(worker=second._engine, lease=object(), key=('foreign',))
        self.driver._shared_entry = foreign
        with self.assertRaisesRegex(RuntimeError, 'зайнятий іншим'):
            self.driver.begin_package_maintenance(first)
        self.assertIs(self.driver._shared_entry, foreign)
        self.assertIsNone(self.driver._package_maintenance)

    def test_private_english_and_idle_shared_workers_retire_before_producers_join(self):
        release = Event()
        workers = [Mock(), Mock(), Mock()]
        for worker in workers:
            worker.retire.side_effect = lambda **kwargs: release.set()
        owner = self.owner(workers[0], workers[1])
        owner._thread = Thread(target=release.wait, daemon=True)
        pending = Thread(target=release.wait, daemon=True)
        owner._retirement_threads = (pending,)
        owner._thread.start()
        pending.start()
        self.driver._shared_entry = dict(worker=workers[2], lease=None, key=('idle',))
        session = self.driver.begin_package_maintenance(owner)
        owner._closed = True
        self.driver.quiesce_package_maintenance(session, timeout=1)
        for worker in workers:
            worker.retire.assert_called_once()
        self.assertFalse(owner._thread.is_alive())
        self.assertFalse(pending.is_alive())
        self.assertTrue(session['quiesced'])
        self.assertTrue(self.driver.end_package_maintenance(session))

    def test_bounded_process_wait_failure_retains_reference_and_prevents_respawn(self):
        worker = self.worker()
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired('owned worker', .05)
        worker._process = process
        with self.assertRaises(subprocess.TimeoutExpired):
            worker.retire(timeout=.05)
        self.assertIs(worker._process, process)
        self.assertTrue(worker._retired)
        process.stdin.close.assert_not_called()
        process.stdout.close.assert_not_called()
        process.wait.assert_called_once()
        # Deadline subtraction can round a fraction of a microsecond upward
        # with Windows' monotonic clock. Keep a strict bounded wait without
        # treating floating-point representation as a lifecycle failure.
        self.assertLessEqual(process.wait.call_args.kwargs['timeout'], .050001)
        worker._process = None  # This fixture owns no real process.

    def test_aborted_reservation_restores_only_original_active_pool_entry(self):
        worker, lease = self.driver.acquire_shared_worker(sys.executable, 'x', self.root, None, 'mixed')
        owner = self.owner(worker)
        owner._worker_lease = lease
        entry = self.driver._shared_entry
        session = self.driver.begin_package_maintenance(owner)
        self.assertIsNone(self.driver._shared_entry)
        self.assertTrue(self.driver.end_package_maintenance(session))
        self.assertIs(self.driver._shared_entry, entry)
        self.assertIs(entry['lease'], lease)
        self.assertFalse(worker._retired)
        other = self.owner()
        owner._closed = True
        self.driver.release_shared_worker(lease)
        next_session = self.driver.begin_package_maintenance(other)
        self.assertFalse(self.driver.end_package_maintenance(session))
        self.assertIs(self.driver._package_maintenance, next_session)
        next_session['quiesced'] = True
        self.driver.end_package_maintenance(next_session)


if __name__ == '__main__':
    unittest.main()
