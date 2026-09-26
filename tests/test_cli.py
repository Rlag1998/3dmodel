from img2mesh.cli import main, parse_args


def test_defaults():
    a = parse_args(["in.png"])
    assert a.depth_model == "base" and a.back_texture == "fill"


def test_rejects_unknown_format(capsys):
    assert main(["in.png", "--formats", "glb,fbx"]) == 2
    assert "fbx" in capsys.readouterr().err
