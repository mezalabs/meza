package main

import (
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"google.golang.org/protobuf/proto"
)

func parseEnvelope(data []byte) (*v1.GatewayEnvelope, error) {
	env := &v1.GatewayEnvelope{}
	if err := proto.Unmarshal(data, env); err != nil {
		return nil, err
	}
	return env, nil
}

func makeEnvelope(op v1.GatewayOpCode, payload []byte) ([]byte, error) {
	env := &v1.GatewayEnvelope{
		Op:      op,
		Payload: payload,
	}
	return proto.Marshal(env)
}
