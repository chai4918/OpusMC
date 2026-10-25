# Tiny no-cache static server for development: py tools/serve.py [port]
import http.server, sys, os

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()
    def log_message(self, *a):
        pass

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'game'))
host = sys.argv[2] if len(sys.argv) > 2 else '0.0.0.0'
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print('serving on http://%s:%d/' % (host, port), flush=True)
http.server.ThreadingHTTPServer((host, port), H).serve_forever()
