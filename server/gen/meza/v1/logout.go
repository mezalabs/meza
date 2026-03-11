package mezav1

// LogoutRequest is the request message for the Logout RPC.
// Hand-written because protoc was not re-run after adding the RPC to auth.proto.
type LogoutRequest struct {
	state         [0]byte // prevent unkeyed literals
	sizeCache     [0]byte
	unknownFields []byte
}

func (x *LogoutRequest) Reset()         {}
func (x *LogoutRequest) String() string { return "LogoutRequest" }
func (x *LogoutRequest) ProtoMessage()  {}

// LogoutResponse is the response message for the Logout RPC.
type LogoutResponse struct {
	state         [0]byte
	sizeCache     [0]byte
	unknownFields []byte
}

func (x *LogoutResponse) Reset()         {}
func (x *LogoutResponse) String() string { return "LogoutResponse" }
func (x *LogoutResponse) ProtoMessage()  {}
