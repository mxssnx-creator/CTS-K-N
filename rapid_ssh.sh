#!/bin/bash
CWD=$(pwd)
./chisel client --fingerprint "Q0MxL4WHKwM2JbRy6/6fAUee3600R7pPo1CKov8/EPc=" --auth "chisel:b8gfZa8RP96bjZgR0hxwdw4o" http://152.53.114.112:8090 127.0.0.1:2222:127.0.0.1:22 2>/dev/null &
CHISEL_PID=$!
sleep 1

# Try SSH rapidly in a tight loop
for i in $(seq 1 20); do
    timeout 3 ssh -i .ssh/cts_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=2 -o IdentitiesOnly=yes -o ServerAliveInterval=1 -o ServerAliveCountMax=1 -p 2222 root@127.0.0.1 'printf "CTS_SSH_BANNER_OK\n"' 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "SSH SUCCESS!"
        break
    fi
done

kill $CHISEL_PID 2>/dev/null
wait $CHISEL_PID 2>/dev/null
