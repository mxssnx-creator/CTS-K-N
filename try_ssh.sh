#!/bin/bash
CWD=$(pwd)

# Start chisel with port forwarding in background
./chisel client --fingerprint "Q0MxL4WHKwM2JbRy6/6fAUee3600R7pPo1CKov8/EPc=" --auth "chisel:iWiwcVhgUQtIo5JPBX5dqmmU" --max-retry-count 3 http://152.53.114.112:8090 127.0.0.1:2222:127.0.0.1:22 2>/dev/null &
CHISEL_PID=$!

# Wait for tunnel to start
sleep 1

# Try SSH in a loop
for i in $(seq 1 5); do
    timeout 4 ssh -i "$CWD/.ssh/cts_ed25519" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o BatchMode=yes \
      -o ConnectTimeout=3 \
      -o IdentitiesOnly=yes \
      -o ServerAliveInterval=1 \
      -o ServerAliveCountMax=1 \
      -p 2222 root@127.0.0.1 \
      'printf "CTS_SSH_BANNER_OK\n"' 2>&1
    if [ $? -eq 0 ]; then
        echo "SSH SUCCESS!"
        kill $CHISEL_PID 2>/dev/null
        exit 0
    fi
    echo "Attempt $i failed, retrying..."
    sleep 0.5
done

kill $CHISEL_PID 2>/dev/null
wait $CHISEL_PID 2>/dev/null
exit 1
