// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

contract VerbatimPrints {
    string public constant name = "Verbatim Prints";
    string public constant symbol = "VPRINT";
    uint256 public immutable price;
    address public immutable payee;
    uint256 public totalSupply;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => bytes32) public imageRoot;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(uint256 indexed tokenId, address indexed to, bytes32 imageRoot, uint256 paid);

    constructor(uint256 price_, address payee_) {
        price = price_;
        payee = payee_;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f;
    }

    function mint(address to, bytes32 root) external payable returns (uint256 tokenId) {
        require(msg.value >= price, "Pay the mint price");
        require(to != address(0), "Mint to someone");
        require(root != bytes32(0), "No image");
        tokenId = ++totalSupply;
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        imageRoot[tokenId] = root;
        emit Transfer(address(0), to, tokenId);
        emit Minted(tokenId, to, root, msg.value);
        (bool paid,) = payee.call{value: msg.value}("");
        require(paid, "Payment failed");
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(ownerOf[tokenId] != address(0), "No such print");
        return string.concat(
            'data:application/json,{"name":"Verbatim Print #',
            decimal(tokenId),
            '","description":"A picture on 0G Storage, drawn by 0G sealed AI or brought by its owner, minted through a Verbatim vault.","image_0g_storage_root":"',
            hex32(imageRoot[tokenId]),
            '"}'
        );
    }

    function approve(address approved, uint256 tokenId) external {
        address owner = ownerOf[tokenId];
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "Not allowed");
        getApproved[tokenId] = approved;
        emit Approval(owner, approved, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(ownerOf[tokenId] == from, "Not the owner");
        require(to != address(0), "Send to someone");
        require(
            msg.sender == from || msg.sender == getApproved[tokenId] || isApprovedForAll[from][msg.sender], "Not allowed"
        );
        delete getApproved[tokenId];
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data)
                    == IERC721Receiver.onERC721Received.selector,
                "Receiver refused"
            );
        }
    }

    function decimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        bytes memory digits;
        while (value > 0) {
            digits = abi.encodePacked(bytes1(uint8(48 + (value % 10))), digits);
            value /= 10;
        }
        return string(digits);
    }

    function hex32(bytes32 value) private pure returns (string memory) {
        bytes memory text = new bytes(66);
        bytes16 symbols = "0123456789abcdef";
        text[0] = "0";
        text[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            text[2 + i * 2] = symbols[uint8(value[i]) >> 4];
            text[3 + i * 2] = symbols[uint8(value[i]) & 0x0f];
        }
        return string(text);
    }
}
