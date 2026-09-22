"""Offline credential/output checks; no real configuration or network access."""
import base64
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.dont_write_bytecode = True
import generate


def main():
    credential = 'offline-test-credential'
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
    with TemporaryDirectory() as directory, patch.dict(os.environ, {'IMAGE_API_KEY': credential}):
        root = Path(directory)
        config = root / 'models.json'
        config.write_text(json.dumps({'providers': {'image': {
            'baseUrl': 'https://image-provider.example/v1', 'apiKey': '$IMAGE_API_KEY',
            'models': [{'id': 'gpt-image-2'}],
        }}}), encoding='utf-8')
        (root / 'source-crop.png').write_bytes(png)
        (root / 'prompt.txt').write_text('Extract one object.', encoding='utf-8')
        assert generate.resolve_key('$IMAGE_API_KEY') == credential
        assert generate.resolve_key('${IMAGE_API_KEY}') == credential
        assert generate.resolve_key('IMAGE_API_KEY') == credential
        for value in ['!echo unsafe', '${MISSING_IMAGE_KEY_FOR_CHECK}', '${IMAGE_API_KEY}-suffix']:
            with patch.dict(os.environ, {'IMAGE_API_KEY': credential}, clear=True):
                try:
                    generate.resolve_key(value)
                except (ValueError, KeyError):
                    pass
                else:
                    raise AssertionError('Unsupported or missing credential reference accepted')
        item = {'type': 'image_generation_call', 'result': base64.b64encode(png).decode('ascii')}
        event = {'type': 'response.completed', 'response': {'output': [item]}}
        output, errors = io.StringIO(), io.StringIO()
        with patch('generate.urllib.request.build_opener') as opener, redirect_stdout(output), redirect_stderr(errors):
            opener.return_value.open.return_value = io.BytesIO(('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n').encode())
            args = [str(root), '--config', str(config), '--provider', 'image']
            assert generate.main(args) == 0
            request = opener.return_value.open.call_args.args[0]
            assert request.full_url == 'https://image-provider.example/v1/responses'
            assert request.get_header('Authorization') == 'Bearer ' + credential
            payload = json.loads(request.data)
            assert payload['tools'][0]['model'] == 'gpt-image-2' and payload['store'] is False
            assert (root / 'generated.png').read_bytes() == png
            assert generate.main(args) == 1  # Existing output must survive without a second request.
            assert opener.return_value.open.call_count == 1
            assert (root / 'generated.png').read_bytes() == png
            (root / 'generated.png').unlink()
            opener.return_value.open.side_effect = RuntimeError('Provider response echoed ' + credential)
            assert generate.main(args) == 1
            assert not (root / 'generated.png').exists()
            status = (root / 'generation-status.json').read_text(encoding='utf-8')
            assert json.loads(status) == {'state': 'failed', 'error_type': 'RuntimeError'}
            assert credential not in output.getvalue() + errors.getvalue() + status
        failed = {'type': 'response.failed', 'response': {'error': {'message': credential}}}
        try:
            generate.receive_image([('data: ' + json.dumps(failed)).encode()])
        except RuntimeError as error:
            assert credential not in str(error)
        else:
            raise AssertionError('Failed stream accepted')
        assert generate.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example') is None
    print('Offline image generation checks passed; no network requests made.')


if __name__ == '__main__':
    main()
