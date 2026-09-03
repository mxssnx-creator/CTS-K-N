import socket, sys, select

def socks5_connect(socks_host, socks_port, target_host, target_port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect((socks_host, socks_port))
    # SOCKS5 greeting
    s.sendall(b'\x05\x01\x00')
    # Read greeting response
    resp = s.recv(2)
    if resp[1] != 0:  # 0 = succeeded
        s.close()
        return None
    # SOCKS5 connect request
    target_bytes = socket.inet_aton(target_host)
    port_bytes = target_port.to_bytes(2, 'big')
    s.sendall(b'\x05\x01\x00\x01' + target_bytes + port_bytes)
    resp = s.recv(10)
    if resp[1] != 0x00:  # 0 = succeeded
        s.close()
        return None
    return s

if __name__ == '__main__':
    socks_host = '127.0.0.1'
    socks_port = 1080
    target_host = '127.0.0.1'
    target_port = 22
    
    s = socks5_connect(socks_host, socks_port, target_host, target_port)
    if s:
        print(f"Connected to {target_host}:{target_port} via SOCKS5", file=sys.stderr)
        # Forward stdin/stdout
        while True:
            r, _, _ = select.select([s, sys.stdin], [], [], 60)
            if s in r:
                data = s.recv(4096)
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            if sys.stdin in r:
                data = sys.stdin.buffer.read(4096)
                if not data:
                    break
                s.sendall(data)
        s.close()
    else:
        print("Failed to connect", file=sys.stderr)
        sys.exit(1)
