"""Tests for file system operations."""

from pathlib import Path

from scaffoldkit.filesystem import copy_file, ensure_directory, write_file


class TestEnsureDirectory:
    def test_creates_new_directory(self, tmp_path: Path):
        target = tmp_path / "a" / "b" / "c"
        assert not target.exists()
        result = ensure_directory(target)
        assert result is True
        assert target.is_dir()

    def test_returns_false_for_existing(self, tmp_path: Path):
        target = tmp_path / "existing"
        target.mkdir()
        result = ensure_directory(target)
        assert result is False

    def test_creates_parents(self, tmp_path: Path):
        target = tmp_path / "deep" / "nested" / "dir"
        ensure_directory(target)
        assert target.is_dir()
        assert (tmp_path / "deep" / "nested").is_dir()


class TestWriteFile:
    def test_writes_new_file(self, tmp_path: Path):
        target = tmp_path / "test.txt"
        result = write_file(target, "hello")
        assert result is True
        assert target.read_text() == "hello"

    def test_creates_parent_dirs(self, tmp_path: Path):
        target = tmp_path / "sub" / "dir" / "test.txt"
        write_file(target, "content")
        assert target.read_text() == "content"

    def test_skips_existing_without_overwrite(self, tmp_path: Path):
        target = tmp_path / "test.txt"
        target.write_text("original")
        result = write_file(target, "new content", overwrite=False)
        assert result is False
        assert target.read_text() == "original"

    def test_overwrites_with_flag(self, tmp_path: Path):
        target = tmp_path / "test.txt"
        target.write_text("original")
        result = write_file(target, "new content", overwrite=True)
        assert result is True
        assert target.read_text() == "new content"

    def test_writes_utf8(self, tmp_path: Path):
        target = tmp_path / "unicode.txt"
        write_file(target, "Umlaute: ae oe ue")
        assert target.read_text(encoding="utf-8") == "Umlaute: ae oe ue"


class TestCopyFile:
    def test_copies_file(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        target = tmp_path / "target.txt"
        result = copy_file(source, target)
        assert result is True
        assert target.read_text() == "content"

    def test_creates_target_parents(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        target = tmp_path / "sub" / "dir" / "target.txt"
        copy_file(source, target)
        assert target.read_text() == "content"

    def test_skips_existing_without_overwrite(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("new")
        target = tmp_path / "target.txt"
        target.write_text("original")
        result = copy_file(source, target, overwrite=False)
        assert result is False
        assert target.read_text() == "original"

    def test_overwrites_with_flag(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("new")
        target = tmp_path / "target.txt"
        target.write_text("original")
        result = copy_file(source, target, overwrite=True)
        assert result is True
        assert target.read_text() == "new"
