"""Generate one PNG candidate through Responses API + gpt-image-2 (stdlib only)."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import sys
import urllib.request


def resolve_key(value):
    if not isinstance(value, str) or not value or value.startswith('!'):
        raise ValueError('Set apiKey to a literal or an environment variable reference')
    reference = re.fullmatch(r'\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})', value)
    if reference:
        key = os.environ[reference[1] or reference[2]]
    elif '$' in value:
        raise ValueError('Only whole-variable environment references are supported')
    else:
        key = os.environ.get(value, value)  # Also accepts the original scripts' bare env names.
    if not key.strip():
        raise ValueError('Empty API key')
    return key


def receive_image(response):
    result, items = None, []
    for raw in response:
        line = raw.decode('utf-8').strip()
        if not line.startswith('data:') or line[5:].strip() == '[DONE]':
            continue
        event = json.loads(line[5:])
        if event.get('type') == 'response.output_item.done':
            items.append(event['item'])
        elif event.get('type') == 'response.completed':
            result = event['response']
        elif event.get('type') in ('error', 'response.failed', 'response.incomplete'):
            raise RuntimeError('Image provider reported failure')
    for item in (result or {}).get('output', items):
        if item.get('type') == 'image_generation_call' and item.get('result'):
            image = base64.b64decode(item['result'], validate=True)
            if not image.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('Image provider returned a non-PNG result')
            return image
    raise RuntimeError('Image provider returned no image')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the bearer credential to a redirected endpoint.


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='Local candidate directory; output is generated.png')
    parser.add_argument('--source', type=Path, help='PNG source; default: directory/source-crop.png')
    parser.add_argument('--reference', type=Path, action='append', default=[], help='Additional PNG reference; repeatable')
    parser.add_argument('--prompt', type=Path, help='UTF-8 prompt; default: directory/prompt.txt')
    parser.add_argument('--config', type=Path, default=Path(os.environ.get('PI_CODING_AGENT_DIR', '~/.pi/agent')).expanduser() / 'models.json')
    parser.add_argument('--provider', help='Provider name; required when multiple providers list gpt-image-2')
    parser.add_argument('--request-model', default='gpt-6-astra', help='Responses request model used to invoke the image tool')
    args = parser.parse_args(argv)
    root = args.directory.expanduser()
    status = root / 'generation-status.json'
    try:
        root.mkdir(parents=True, exist_ok=True)
        output = root / 'generated.png'
        if output.exists():
            raise FileExistsError('Use a new candidate directory')
        config = json.loads(args.config.expanduser().read_text(encoding='utf-8-sig'))
        providers = [p for name, p in config['providers'].items()
                     if (not args.provider or name == args.provider)
                     and any(m.get('id') == 'gpt-image-2' for m in p.get('models', []))]
        if len(providers) != 1:
            raise ValueError('Select exactly one provider listing gpt-image-2')
        provider = providers[0]
        key = resolve_key(provider['apiKey'])
        content = [{'type': 'input_text', 'text': (args.prompt or root / 'prompt.txt').expanduser().read_text(encoding='utf-8-sig')}]
        for path in [args.source or root / 'source-crop.png', *args.reference]:
            image = path.expanduser().read_bytes()
            if not image.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('Source and reference images must be PNG')
            content.append({'type': 'input_image', 'image_url': 'data:image/png;base64,' + base64.b64encode(image).decode('ascii')})
        payload = {
            'model': args.request_model, 'stream': True, 'store': False,
            'instructions': 'Edit the supplied image using the image_generation tool. Use the specified image model.',
            'input': [{'role': 'user', 'content': content}],
            'tools': [{'type': 'image_generation', 'model': 'gpt-image-2', 'size': '1024x1024', 'quality': 'high', 'background': 'opaque', 'output_format': 'png'}],
            'tool_choice': {'type': 'image_generation'},
        }
        request = urllib.request.Request(provider['baseUrl'].rstrip('/') + '/responses',
                                         data=json.dumps(payload).encode('utf-8'),
                                         headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
        status.write_text(json.dumps({'state': 'running', 'model': 'gpt-image-2'}), encoding='utf-8')
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=480) as response:
            image = receive_image(response)
        with output.open('xb') as file:
            file.write(image)
        status.write_text(json.dumps({'state': 'complete', 'model': 'gpt-image-2', 'file': output.name}), encoding='utf-8')
        print('Generated candidate: generated.png')
        return 0
    except Exception as error:
        # Do not echo exception text, request headers, config values or provider responses.
        failure = {'state': 'failed', 'error_type': type(error).__name__}
        try:
            status.write_text(json.dumps(failure), encoding='utf-8')
        except OSError:
            pass
        print(json.dumps(failure), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
